require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const YTDlpWrap = require('yt-dlp-exec');

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── STATE ─────────────────────────────────────────────────────────────────────
const DB_FILE = './social_state.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch { return { posted:[], manualQueue:[], stats:{totalPosted:0,today:0,lastReset:new Date().toDateString()}, streamers:[], lastRun:null, log:[] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2)); }
function addLog(msg) {
  console.log(msg);
  try { const db=loadDB(); db.log=db.log||[]; db.log.unshift(`[${new Date().toISOString().slice(11,19)}] ${msg}`); if(db.log.length>100)db.log=db.log.slice(0,100); saveDB(db); } catch(e){}
}

// ── TOP STREAMERS ─────────────────────────────────────────────────────────────
const TOP_STREAMERS = [
  { slug:'xqc',           name:'xQc'        },
  { slug:'adinross',      name:'AdinRoss'   },
  { slug:'trainwreckstv', name:'Trainwreck' },
  { slug:'kaicenat',      name:'KaiCenat'   },
  { slug:'speed',         name:'IShowSpeed' },
  { slug:'n3on',          name:'N3on'       },
  { slug:'jynxzi',        name:'Jynxzi'     },
];

// ── KICK CLIPS VIA YTDLP-EXEC ─────────────────────────────────────────────────
async function getClipsForStreamer(slug, name) {
  try {
    const result = await YTDlpWrap(`https://kick.com/${slug}/clips`, {
      flatPlaylist: true,
      dumpSingleJson: true,
      playlistEnd: 8,
      noWarnings: true,
    });
    const entries = result.entries || [];
    const clips = entries
      .filter(c => c && c.id)
      .filter(c => (c.duration || 30) <= 65)
      .map(c => ({
        id: c.id,
        title: c.title || `${name} clip`,
        url: c.webpage_url || `https://kick.com/${slug}?clip=${c.id}`,
        views: c.view_count || 0,
        duration: c.duration || 30,
        streamerName: name,
        channel: slug,
      }));
    addLog(`[Kick] ${name}: ${clips.length} clips found`);
    return clips;
  } catch(e) {
    addLog(`[Kick] ${name}: ${e.message.slice(0,80)}`);
    return [];
  }
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────
async function downloadClip(url, outputPath) {
  try {
    await YTDlpWrap(url, {
      format: 'best[ext=mp4][filesize<48M]/best[filesize<48M]/best',
      output: outputPath,
      noPlaylist: true,
      socketTimeout: 30,
    });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) return;
    throw new Error('File not created or too small');
  } catch(e) {
    // Fallback: direct HTTP download
    addLog(`[Download] yt-dlp failed (${e.message.slice(0,50)}), trying direct...`);
    const res = await axios({ url, responseType:'stream', timeout:60000, headers:{ 'User-Agent':'Mozilla/5.0', 'Referer':'https://kick.com/' } });
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(outputPath);
      res.data.pipe(w);
      w.on('finish', resolve); w.on('error', reject);
    });
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 5000) throw new Error('Download too small');
  }
}

// ── CAPTION ───────────────────────────────────────────────────────────────────
async function generateCaption(clip) {
  try {
    const msg = await client.messages.create({
      model:'claude-sonnet-4-20250514', max_tokens:200,
      system:'Write viral TikTok captions for gaming clips. Punchy, emojis, under 100 chars. Credit streamer.',
      messages:[{role:'user',content:`Caption for: "${clip.title}" by @${clip.streamerName} on Kick\nCAPTION: [text]\nHASHTAGS: [tags]`}]
    });
    const t = msg.content[0].text;
    return {
      caption: ((t.match(/CAPTION:\s*(.+)/)||[])[1]||`🔥 ${clip.title}`).trim()+` 📺@${clip.streamerName}`,
      hashtags: ((t.match(/HASHTAGS:\s*(.+)/)||[])[1]||`#${clip.streamerName.toLowerCase()} #kick #gaming #fyp #viral`).trim()
    };
  } catch(e) {
    return { caption:`🔥 ${clip.title} 📺@${clip.streamerName}`, hashtags:`#${clip.streamerName.toLowerCase()} #kick #gaming #fyp` };
  }
}

// ── TIKTOK ────────────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db = loadDB();
  const token = db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!token || token.length < 10) { addLog('[TikTok] No token'); return {success:false,reason:'no_token'}; }
  try {
    const buf = fs.readFileSync(videoPath);
    const init = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/',
      { post_info:{ title:`${caption} ${hashtags}`.slice(0,150), privacy_level:'PUBLIC_TO_EVERYONE', disable_duet:false, disable_comment:false, disable_stitch:false }, source_info:{ source:'FILE_UPLOAD', video_size:buf.length } },
      { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    await axios.put(init.data.data.upload_url, buf, { headers:{ 'Content-Type':'video/mp4', 'Content-Range':`bytes 0-${buf.length-1}/${buf.length}` } });
    addLog('[TikTok] ✓ Posted!');
    return { success:true };
  } catch(e) {
    addLog('[TikTok] Failed: '+(e.response?.data?.error?.message||e.message));
    return { success:false, reason:e.message };
  }
}

// ── PROCESS ONE CLIP ──────────────────────────────────────────────────────────
async function processClip(clip) {
  addLog(`[Agent] Processing: "${clip.title}" by ${clip.streamerName}`);
  const { caption, hashtags } = await generateCaption(clip);
  const dir = './videos'; if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const videoPath = path.join(dir, `${(clip.id||Date.now()).toString().replace(/[^a-z0-9]/gi,'')}.mp4`);
  await downloadClip(clip.url, videoPath);
  addLog(`[Agent] Downloaded: ${Math.round(fs.statSync(videoPath).size/1024)}KB`);
  const result = await postToTikTok(videoPath, caption, hashtags);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  return { ...clip, caption, hashtags, ...result };
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function runAgent() {
  addLog('[Agent] Starting run');
  const db = loadDB();
  if (db.stats.lastReset !== new Date().toDateString()) { db.stats.today=0; db.stats.lastReset=new Date().toDateString(); }

  // Manual queue first
  const manual = (db.manualQueue||[]).filter(c=>c.status==='queued');
  for (const clip of manual.slice(0,3)) {
    try {
      const result = await processClip(clip);
      clip.status = result.success ? 'posted' : 'failed';
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      db.posted.unshift({...clip, postedAt:new Date().toISOString()});
      saveDB(db);
      await new Promise(r=>setTimeout(r,15000));
    } catch(e) { clip.status='failed'; clip.error=e.message; saveDB(db); addLog('[Agent] Error: '+e.message); }
  }

  // Auto discover
  const streamers = TOP_STREAMERS.slice(0,5);
  db.streamers = streamers; saveDB(db);
  let allClips = [];
  for (const s of streamers) {
    const clips = await getClipsForStreamer(s.slug, s.name);
    allClips.push(...clips);
    await new Promise(r=>setTimeout(r,2000));
  }

  const postedIds = db.posted.map(p=>p.clipId||p.id||p.clip_id);
  const newClips = allClips.filter(c=>c.id&&!postedIds.includes(c.id)).sort((a,b)=>b.views-a.views).slice(0,2);
  addLog(`[Agent] ${allClips.length} total clips, ${newClips.length} new`);

  for (const clip of newClips) {
    try {
      const result = await processClip(clip);
      db.posted.unshift({ clipId:clip.id, ...clip, ...result, postedAt:new Date().toISOString() });
      if (db.posted.length>100) db.posted=db.posted.slice(0,100);
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      saveDB(db);
      await new Promise(r=>setTimeout(r,20000));
    } catch(e) { addLog('[Agent] Error: '+e.message); }
  }

  db.lastRun = new Date().toISOString(); saveDB(db);
  addLog(`[Agent] Done. Posted today: ${db.stats.today}`);
}

// ── WEB UI + ROUTES ───────────────────────────────────────────────────────────
app.get('/', (req,res) => {
  const db = loadDB();
  const tiktokConnected = !!(db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN);
  res.send(`<!DOCTYPE html><html><head><title>Social Agent</title>
  <style>*{box-sizing:border-box}body{font-family:monospace;background:#060a1a;color:#ccc;padding:20px;max-width:860px;margin:0 auto}
  h1{color:#cc44ff;margin-bottom:4px}h2{color:#888;font-size:12px;letter-spacing:2px;margin:16px 0 8px}
  .card{background:#0d1225;border:1px solid rgba(200,68,255,0.2);padding:14px;margin:10px 0;border-radius:4px}
  .stat{display:inline-block;margin-right:20px;font-size:13px}
  .stat b{color:#cc44ff}
  input{background:#060a1a;border:1px solid #cc44ff44;color:#fff;padding:8px 10px;width:100%;margin:4px 0;font-family:monospace;border-radius:3px;font-size:11px}
  button{background:rgba(200,68,255,0.15);border:1px solid #cc44ff;color:#cc44ff;padding:8px 18px;cursor:pointer;font-family:monospace;border-radius:3px;margin-top:8px;font-size:11px}
  button:hover{background:rgba(200,68,255,0.3)}
  .ok{color:#00ff88}.warn{color:#ffa500}.err{color:#ff4444}
  .log{max-height:180px;overflow-y:auto;font-size:10px;color:#555;line-height:1.6}
  .item{padding:5px 0;border-bottom:1px solid #0d1225;font-size:11px}
  a{color:#cc44ff}</style></head>
  <body>
  <h1>🤖 SOCIAL AGENT</h1>
  <div class="card">
    <span class="stat">📊 Today: <b>${db.stats.today}</b></span>
    <span class="stat">✅ Total: <b>${db.stats.totalPosted}</b></span>
    <span class="stat">TikTok: <b class="${tiktokConnected?'ok':'warn'}">${tiktokConnected?'CONNECTED':'<a href="/tiktok/connect">CONNECT</a>'}</b></span>
    <span class="stat">Last run: <b>${db.lastRun?db.lastRun.slice(11,19):'never'}</b></span>
  </div>
  <div class="card">
    <h2>ADD KICK CLIP</h2>
    <p style="font-size:10px;color:#555;margin-bottom:8px">Go to Kick, find a clip, copy the URL and paste it here. Agent will download and post to TikTok automatically.</p>
    <input id="clipUrl" placeholder="https://kick.com/xqc?clip=clip_01...  or  https://kick.com/xqc/clips/..."/>
    <input id="clipStreamer" placeholder="Streamer name (e.g. xQc)"/>
    <button onclick="addClip()">➕ ADD TO QUEUE</button> <span id="msg" style="font-size:11px;margin-left:10px"></span>
    <button onclick="runNow()" style="margin-left:10px;background:rgba(0,255,136,0.1);border-color:#00ff88;color:#00ff88">▶ RUN NOW</button>
  </div>
  <div class="card">
    <h2>QUEUE (${(db.manualQueue||[]).filter(c=>c.status==='queued').length} pending)</h2>
    ${(db.manualQueue||[]).slice(0,8).map(c=>`<div class="item">${c.status==='queued'?'⏳':c.status==='posted'?'✅':'❌'} <b style="color:#cc44ff">@${c.streamer||'?'}</b> — ${(c.title||c.url||'').slice(0,60)}</div>`).join('')||'<span style="color:#333;font-size:11px">No clips queued — add one above</span>'}
  </div>
  <div class="card">
    <h2>RECENT POSTS</h2>
    ${db.posted.slice(0,6).map(p=>`<div class="item">${p.success?'✅':'📋'} <b style="color:#cc44ff">@${p.streamerName||p.streamer||'?'}</b> — ${(p.title||p.clipId||'').slice(0,55)}</div>`).join('')||'<span style="color:#333;font-size:11px">No posts yet</span>'}
  </div>
  <div class="card">
    <h2>AGENT LOG</h2>
    <div class="log">${(db.log||[]).map(l=>`<div>${l}</div>`).join('')}</div>
  </div>
  <script>
  async function addClip(){
    const url=document.getElementById('clipUrl').value.trim();
    const streamer=document.getElementById('clipStreamer').value.trim()||'Unknown';
    const msg=document.getElementById('msg');
    if(!url){msg.textContent='Enter a URL first';return;}
    msg.textContent='Adding...';
    const r=await fetch('/add-clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,streamer})});
    const d=await r.json();
    msg.style.color=d.success?'#00ff88':'#ff4444';
    msg.textContent=d.success?'✓ Added! Running now...':'Error: '+d.error;
    if(d.success){document.getElementById('clipUrl').value='';fetch('/run-now',{method:'POST'});setTimeout(()=>location.reload(),3000);}
  }
  async function runNow(){const r=await fetch('/run-now',{method:'POST'});const d=await r.json();alert(d.message);setTimeout(()=>location.reload(),5000);}
  setTimeout(()=>location.reload(),20000);
  </script></body></html>`);
});

app.get('/status', (req,res) => {
  const db=loadDB();
  res.json({ status:'running', stats:db.stats, lastRun:db.lastRun, recentPosts:db.posted.slice(0,5), queue:(db.manualQueue||[]).filter(c=>c.status==='queued').length, log:(db.log||[]).slice(0,10) });
});

app.post('/add-clip', (req,res) => {
  const{url,streamer,title}=req.body;
  if(!url)return res.status(400).json({error:'URL required'});
  const db=loadDB(); db.manualQueue=db.manualQueue||[];
  const id='manual_'+Date.now();
  db.manualQueue.unshift({id,clipId:id,url,streamer:streamer||'Unknown',title:title||'Kick Clip',status:'queued',addedAt:new Date().toISOString()});
  if(db.manualQueue.length>50)db.manualQueue=db.manualQueue.slice(0,50);
  saveDB(db); addLog(`[Queue] Added: ${url.slice(0,60)}`);
  res.json({success:true,message:'Added to queue'});
});

app.get('/posted', (req,res) => res.json(loadDB().posted.slice(0,20)));
app.get('/queue',  (req,res) => res.json((loadDB().manualQueue||[]).slice(0,20)));

app.post('/run-now', (req,res) => {
  res.json({message:'Agent started'});
  runAgent().catch(e=>addLog('[Agent] Error: '+e.message));
});

app.post('/tiktok-token', (req,res) => {
  const db=loadDB(); db.tiktokToken=req.body.access_token; if(req.body.refresh_token)db.tiktokRefresh=req.body.refresh_token; saveDB(db);
  addLog('[TikTok] Token saved'); res.json({success:true});
});

app.get('/tiktok/connect', (req,res) => {
  const ru=encodeURIComponent(process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`);
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish&response_type=code&redirect_uri=${ru}&state=agentnet`);
});

app.get('/tiktok/callback', async (req,res) => {
  const{code}=req.query; if(!code)return res.status(400).send('No code');
  try{
    const t=await axios.post('https://open.tiktokapis.com/v2/oauth/token/',{
      client_key:process.env.TIKTOK_CLIENT_KEY, client_secret:process.env.TIKTOK_CLIENT_SECRET,
      code, grant_type:'authorization_code',
      redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`
    });
    const db=loadDB(); db.tiktokToken=t.data.access_token; db.tiktokRefresh=t.data.refresh_token; saveDB(db);
    addLog('[TikTok] OAuth complete ✓');
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! Close this tab.</h2>');
  }catch(e){res.status(500).send('Error: '+e.message);}
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  addLog(`Social Agent running on port ${PORT}`);
  setTimeout(()=>runAgent().catch(e=>addLog('[Agent] Startup error: '+e.message)), 8000);
});
cron.schedule('0 */2 * * *', ()=>runAgent().catch(e=>addLog('[Agent] Cron error: '+e.message)));
