require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── STATE ─────────────────────────────────────────────────────────────────────
const DB_FILE = './social_state.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch { return { posted:[], manualQueue:[], stats:{totalPosted:0,today:0,lastReset:new Date().toDateString()}, lastRun:null, log:[] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2)); }
function addLog(msg) {
  console.log(msg);
  try { const db=loadDB(); db.log=db.log||[]; db.log.unshift(`[${new Date().toISOString().slice(11,19)}] ${msg}`); if(db.log.length>100)db.log=db.log.slice(0,100); saveDB(db); } catch(e){}
}

// ── REDDIT AUTO-DISCOVERY ─────────────────────────────────────────────────────
// r/LivestreamFail posts Kick clips constantly — no auth needed
async function getClipsFromReddit() {
  try {
    const subs = ['LivestreamFail', 'Kick_clips', 'kickstreaming'];
    let clips = [];
    for (const sub of subs) {
      try {
        const res = await axios.get(`https://www.reddit.com/r/${sub}/new.json?limit=25`, {
          headers: { 'User-Agent': 'AgentNetBot/1.0' }, timeout: 10000
        });
        const posts = res.data.data.children.map(p => p.data);
        const kickPosts = posts.filter(p =>
          p.url && (p.url.includes('kick.com') || p.url.includes('clips.kick.com')) &&
          !p.is_self && p.score > 10
        );
        for (const post of kickPosts) {
          clips.push({
            id: 'reddit_'+post.id,
            title: post.title,
            url: post.url,
            views: post.score,
            duration: 30,
            streamerName: extractStreamer(post.url, post.title),
            channel: extractStreamer(post.url, post.title),
            source: 'reddit_'+sub
          });
        }
        addLog(`[Reddit] r/${sub}: ${kickPosts.length} kick clips`);
      } catch(e) { addLog(`[Reddit] r/${sub} failed: ${e.message.slice(0,50)}`); }
      await new Promise(r=>setTimeout(r,1000));
    }
    return clips.sort((a,b) => b.views - a.views);
  } catch(e) {
    addLog('[Reddit] Error: '+e.message);
    return [];
  }
}

function extractStreamer(url, title) {
  // Try to extract streamer from kick URL
  const match = url.match(/kick\.com\/([^\/\?]+)/);
  if (match && match[1] !== 'clips') return match[1];
  // Try from title
  const names = ['xQc','AdinRoss','Trainwreck','KaiCenat','Speed','N3on','Jynxzi','Nickmercs'];
  for (const n of names) { if (title.toLowerCase().includes(n.toLowerCase())) return n; }
  return 'Kick';
}

// ── DOWNLOAD VIA YT-DLP ───────────────────────────────────────────────────────
function downloadClip(url, outputPath) {
  return new Promise((resolve, reject) => {
    // yt-dlp handles individual kick clip URLs well
    const cmd = `yt-dlp -f "best[ext=mp4][filesize<48M]/best[filesize<48M]/best" -o "${outputPath}" "${url}" --no-playlist -q --socket-timeout 30 2>&1`;
    addLog(`[Download] Starting: ${url.slice(0,60)}`);
    exec(cmd, { timeout: 90000 }, async (err, stdout) => {
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
        addLog(`[Download] ✓ ${Math.round(fs.statSync(outputPath).size/1024)}KB`);
        resolve(); return;
      }
      addLog(`[Download] yt-dlp failed: ${(stdout||'').slice(0,80)}, trying direct...`);
      try {
        const res = await axios({ url, responseType:'stream', timeout:60000,
          headers:{ 'User-Agent':'Mozilla/5.0', 'Referer':'https://kick.com/' }
        });
        const w = fs.createWriteStream(outputPath);
        res.data.pipe(w);
        w.on('finish', () => {
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
            addLog(`[Download] ✓ Direct ${Math.round(fs.statSync(outputPath).size/1024)}KB`);
            resolve();
          } else reject(new Error('File too small after direct download'));
        });
        w.on('error', reject);
      } catch(e2) { reject(new Error('All download methods failed: '+e2.message)); }
    });
  });
}

// ── CAPTION ───────────────────────────────────────────────────────────────────
async function generateCaption(clip) {
  try {
    const msg = await client.messages.create({
      model:'claude-sonnet-4-20250514', max_tokens:200,
      system:'Write viral TikTok captions for gaming/streaming clips. Punchy, emojis, under 100 chars. Always credit the streamer.',
      messages:[{role:'user',content:`Caption for Kick clip: "${clip.title}" by @${clip.streamerName}\nCAPTION: [punchy text + emojis]\nHASHTAGS: [include #${clip.streamerName.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral]`}]
    });
    const t = msg.content[0].text;
    return {
      caption: ((t.match(/CAPTION:\s*(.+)/)||[])[1]||`🔥 ${clip.title.slice(0,60)}`).trim()+` 📺@${clip.streamerName}`,
      hashtags: ((t.match(/HASHTAGS:\s*(.+)/)||[])[1]||`#${clip.streamerName.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral`).trim()
    };
  } catch(e) {
    return {
      caption: `🔥 ${clip.title.slice(0,60)} 📺@${clip.streamerName}`,
      hashtags: `#${clip.streamerName.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral`
    };
  }
}

// ── TIKTOK POST ───────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db = loadDB();
  const token = db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!token || token.length < 10) {
    addLog('[TikTok] No token — clip ready in queue for when TikTok is connected');
    return { success:false, reason:'no_token' };
  }
  try {
    const buf = fs.readFileSync(videoPath);
    const init = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      { post_info:{ title:`${caption} ${hashtags}`.slice(0,150), privacy_level:'PUBLIC_TO_EVERYONE', disable_duet:false, disable_comment:false, disable_stitch:false },
        source_info:{ source:'FILE_UPLOAD', video_size:buf.length } },
      { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    await axios.put(init.data.data.upload_url, buf, {
      headers:{ 'Content-Type':'video/mp4', 'Content-Range':`bytes 0-${buf.length-1}/${buf.length}` }
    });
    addLog('[TikTok] ✓ Posted successfully!');
    return { success:true };
  } catch(e) {
    addLog('[TikTok] Failed: '+(e.response?.data?.error?.message||e.message).slice(0,100));
    return { success:false, reason:e.message };
  }
}

// ── PROCESS CLIP ──────────────────────────────────────────────────────────────
async function processClip(clip) {
  const { caption, hashtags } = await generateCaption(clip);
  const dir = './videos'; if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const safeId = String(clip.id||Date.now()).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
  const videoPath = path.join(dir, `${safeId}.mp4`);
  await downloadClip(clip.url, videoPath);
  const result = await postToTikTok(videoPath, caption, hashtags);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  return { ...clip, caption, hashtags, ...result };
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────
async function runAgent() {
  addLog('[Agent] ── Starting run ──');
  const db = loadDB();
  if (db.stats.lastReset !== new Date().toDateString()) { db.stats.today=0; db.stats.lastReset=new Date().toDateString(); }

  // 1. Process manual queue first
  const manual = (db.manualQueue||[]).filter(c=>c.status==='queued');
  if (manual.length > 0) addLog(`[Agent] Processing ${manual.length} manual clip(s)`);
  for (const clip of manual.slice(0,3)) {
    try {
      addLog(`[Agent] Manual: "${clip.title}" by ${clip.streamer}`);
      const result = await processClip({...clip, streamerName:clip.streamer});
      clip.status = result.success ? 'posted' : (result.reason==='no_token' ? 'ready_no_token' : 'failed');
      clip.caption = result.caption; clip.hashtags = result.hashtags;
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      db.posted.unshift({...clip, postedAt:new Date().toISOString(), success:result.success});
      saveDB(db);
      if (manual.length > 1) await new Promise(r=>setTimeout(r,15000));
    } catch(e) {
      clip.status = 'failed'; clip.error = e.message;
      addLog('[Agent] Manual clip error: '+e.message);
      saveDB(db);
    }
  }

  // 2. Auto-discover from Reddit
  addLog('[Agent] Checking Reddit for Kick clips...');
  const redditClips = await getClipsFromReddit();
  const postedIds = db.posted.map(p=>p.id||p.clipId);
  const newClips = redditClips.filter(c=>!postedIds.includes(c.id)).slice(0,2);
  addLog(`[Agent] Reddit: ${redditClips.length} clips found, ${newClips.length} new`);

  for (const clip of newClips) {
    try {
      const result = await processClip(clip);
      db.posted.unshift({...clip, ...result, postedAt:new Date().toISOString()});
      if (db.posted.length>100) db.posted=db.posted.slice(0,100);
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      saveDB(db);
      await new Promise(r=>setTimeout(r,20000));
    } catch(e) { addLog('[Agent] Reddit clip error: '+e.message); }
  }

  db.lastRun = new Date().toISOString(); saveDB(db);
  addLog(`[Agent] Done. Posted today: ${db.stats.today}`);
}

// ── WEB UI ────────────────────────────────────────────────────────────────────
app.get('/', (req,res) => {
  const db = loadDB();
  const tiktokOk = !!(db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN);
  const pending = (db.manualQueue||[]).filter(c=>c.status==='queued').length;
  res.send(`<!DOCTYPE html><html><head><title>Social Agent</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>*{box-sizing:border-box}body{font-family:monospace;background:#060a1a;color:#ccc;padding:20px;max-width:800px;margin:0 auto;font-size:13px}
  h1{color:#cc44ff;margin-bottom:4px;font-size:18px}
  h2{color:#666;font-size:10px;letter-spacing:2px;margin:16px 0 8px;text-transform:uppercase}
  .card{background:#0d1225;border:1px solid rgba(200,68,255,0.18);padding:14px;margin:10px 0;border-radius:4px}
  .stats{display:flex;flex-wrap:wrap;gap:16px;font-size:12px}
  .stat b{color:#cc44ff}
  input{background:#060a1a;border:1px solid #cc44ff44;color:#fff;padding:9px 11px;width:100%;margin:4px 0;font-family:monospace;border-radius:3px;font-size:12px}
  .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  button{background:rgba(200,68,255,0.12);border:1px solid #cc44ff;color:#cc44ff;padding:9px 18px;cursor:pointer;font-family:monospace;border-radius:3px;font-size:11px;letter-spacing:.5px}
  button:hover{background:rgba(200,68,255,0.25)}
  .btn-green{background:rgba(0,255,136,0.08);border-color:#00ff88;color:#00ff88}
  .btn-green:hover{background:rgba(0,255,136,0.2)}
  .ok{color:#00ff88}.warn{color:#ffa500}.err{color:#ff4444}
  .log{max-height:200px;overflow-y:auto;font-size:10px;color:#444;line-height:1.7;margin-top:6px}
  .item{padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px}
  .tag{display:inline-block;padding:1px 6px;border-radius:2px;font-size:9px;margin-right:4px}
  .t-posted{background:rgba(0,255,136,0.1);color:#00ff88;border:1px solid rgba(0,255,136,0.2)}
  .t-queued{background:rgba(255,200,0,0.1);color:#ffc800;border:1px solid rgba(255,200,0,0.2)}
  .t-ready{background:rgba(0,180,255,0.1);color:#00b4ff;border:1px solid rgba(0,180,255,0.2)}
  .t-failed{background:rgba(255,60,60,0.1);color:#ff6060;border:1px solid rgba(255,60,60,0.2)}
  a{color:#cc44ff;text-decoration:none}a:hover{text-decoration:underline}
  #msg{font-size:11px;margin-top:8px;min-height:16px}
  </style></head><body>
  <h1>🤖 SOCIAL AGENT</h1>
  <p style="color:#444;font-size:10px;margin-bottom:12px">Autonomous TikTok clip bot — Kick + Reddit auto-discovery</p>

  <div class="card">
    <div class="stats">
      <span class="stat">📊 Today: <b>${db.stats.today}</b></span>
      <span class="stat">✅ Total: <b>${db.stats.totalPosted}</b></span>
      <span class="stat">⏳ Queue: <b>${pending}</b></span>
      <span class="stat">⏱ Last run: <b>${db.lastRun?db.lastRun.slice(11,19):'never'}</b></span>
      <span class="stat">TikTok: <b class="${tiktokOk?'ok':'warn'}">${tiktokOk?'✓ Connected':'<a href="/tiktok/connect">Connect →</a>'}</b></span>
    </div>
  </div>

  <div class="card">
    <h2>Add Kick Clip Manually</h2>
    <p style="color:#555;font-size:10px;margin-bottom:10px">Go to Kick → find a clip → copy the URL → paste here. Agent downloads and posts to TikTok.</p>
    <input id="cu" placeholder="https://kick.com/xqc/clips/123456  or  https://kick.com/xqc?clip=clip_01..."/>
    <input id="cs" placeholder="Streamer name (e.g. xQc)"/>
    <div class="btns">
      <button onclick="addClip()">➕ Add to Queue</button>
      <button class="btn-green" onclick="runNow()">▶ Run Agent Now</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <h2>Queue (${pending} pending)</h2>
    ${(db.manualQueue||[]).slice(0,8).map(c=>`
      <div class="item">
        <span class="tag t-${c.status==='queued'?'queued':c.status==='posted'?'posted':c.status.includes('ready')?'ready':'failed'}">${c.status}</span>
        <b style="color:#cc44ff">@${c.streamer}</b> — ${(c.title||c.url||'').slice(0,55)}
      </div>`).join('')||'<div style="color:#333;font-size:11px;padding:8px 0">No clips queued yet — paste a Kick clip URL above</div>'}
  </div>

  <div class="card">
    <h2>Recent Posts</h2>
    ${db.posted.slice(0,6).map(p=>`
      <div class="item">
        <span class="tag t-${p.success?'posted':'ready'}">${p.success?'posted':'saved'}</span>
        <b style="color:#cc44ff">@${p.streamerName||p.streamer||'?'}</b> — ${(p.title||'').slice(0,55)}
        ${p.caption?`<div style="color:#555;font-size:10px;margin-top:2px">${p.caption.slice(0,80)}</div>`:''}
      </div>`).join('')||'<div style="color:#333;font-size:11px;padding:8px 0">No posts yet</div>'}
  </div>

  <div class="card">
    <h2>Agent Log</h2>
    <div class="log">${(db.log||[]).map(l=>`<div>${l}</div>`).join('')||'<span style="color:#333">No activity yet</span>'}</div>
  </div>

  <script>
  async function addClip(){
    const url=document.getElementById('cu').value.trim();
    const s=document.getElementById('cs').value.trim()||'Unknown';
    const msg=document.getElementById('msg');
    if(!url){msg.innerHTML='<span class="err">Enter a URL first</span>';return;}
    msg.innerHTML='Adding...';
    const r=await fetch('/add-clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,streamer:s})});
    const d=await r.json();
    if(d.success){
      msg.innerHTML='<span class="ok">✓ Added! Click Run Agent Now to process it.</span>';
      document.getElementById('cu').value='';document.getElementById('cs').value='';
    } else { msg.innerHTML='<span class="err">Error: '+d.error+'</span>'; }
  }
  async function runNow(){
    document.getElementById('msg').innerHTML='<span class="ok">▶ Agent started...</span>';
    await fetch('/run-now',{method:'POST'});
    setTimeout(()=>location.reload(),8000);
  }
  setTimeout(()=>location.reload(),25000);
  </script></body></html>`);
});

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get('/status', (req,res) => {
  const db=loadDB();
  res.json({ status:'running', stats:db.stats, lastRun:db.lastRun, pending:(db.manualQueue||[]).filter(c=>c.status==='queued').length, recentPosts:db.posted.slice(0,5), log:(db.log||[]).slice(0,15) });
});

app.post('/add-clip', (req,res) => {
  const{url,streamer,title}=req.body;
  if(!url)return res.status(400).json({error:'URL required'});
  const db=loadDB(); db.manualQueue=db.manualQueue||[];
  const id='m_'+Date.now();
  db.manualQueue.unshift({id,clipId:id,url,streamer:streamer||'Unknown',title:title||'Kick Clip',status:'queued',addedAt:new Date().toISOString()});
  if(db.manualQueue.length>50)db.manualQueue=db.manualQueue.slice(0,50);
  saveDB(db); addLog(`[Queue] Added: ${url.slice(0,60)}`);
  res.json({success:true,message:'Added to queue'});
});

app.get('/posted', (req,res)=>res.json(loadDB().posted.slice(0,20)));
app.get('/queue',  (req,res)=>res.json((loadDB().manualQueue||[]).slice(0,20)));

app.post('/run-now', (req,res) => {
  res.json({message:'Agent started'});
  runAgent().catch(e=>addLog('[Agent] Error: '+e.message));
});

app.post('/tiktok-token', (req,res) => {
  const db=loadDB(); db.tiktokToken=req.body.access_token; if(req.body.refresh_token)db.tiktokRefresh=req.body.refresh_token;
  saveDB(db); addLog('[TikTok] Token saved ✓'); res.json({success:true});
});

app.get('/tiktok/connect', (req,res) => {
  const ru=encodeURIComponent(process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`);
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish&response_type=code&redirect_uri=${ru}&state=agentnet`);
});

app.get('/tiktok/callback', async (req,res) => {
  const{code}=req.query; if(!code)return res.status(400).send('No code');
  try{
    const t=await axios.post('https://open.tiktokapis.com/v2/oauth/token/',{
      client_key:process.env.TIKTOK_CLIENT_KEY,client_secret:process.env.TIKTOK_CLIENT_SECRET,
      code,grant_type:'authorization_code',
      redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`
    });
    const db=loadDB(); db.tiktokToken=t.data.access_token; db.tiktokRefresh=t.data.refresh_token; saveDB(db);
    addLog('[TikTok] ✓ OAuth complete');
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! Close this tab and run the agent.</h2>');
  }catch(e){res.status(500).send('Error: '+e.message);}
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, ()=>{
  addLog(`Social Agent on port ${PORT}`);
  setTimeout(()=>runAgent().catch(e=>addLog('[Agent] Startup: '+e.message)), 10000);
});
cron.schedule('0 */2 * * *', ()=>{ addLog('[Cron] Scheduled run'); runAgent().catch(e=>addLog('[Agent] Cron error: '+e.message)); });
