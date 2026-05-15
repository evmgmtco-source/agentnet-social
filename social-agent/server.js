require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

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
  try {
    const db=loadDB(); db.log=db.log||[];
    db.log.unshift(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
    if(db.log.length>100) db.log=db.log.slice(0,100);
    saveDB(db);
  } catch(e){}
}

// ── TOOL CHECK ────────────────────────────────────────────────────────────────
function getTools() {
  const r = {};
  try { r.ytdlp = execSync('yt-dlp --version 2>&1').toString().trim(); } catch(e) { r.ytdlp = 'NOT INSTALLED'; }
  try { r.ffmpeg = execSync('ffmpeg -version 2>&1 | head -1').toString().trim().slice(0,60); } catch(e) { r.ffmpeg = 'NOT INSTALLED'; }
  try { r.python = execSync('python3 --version 2>&1').toString().trim(); } catch(e) { r.python = 'NOT INSTALLED'; }
  return r;
}

// ── KICK CLIPS ────────────────────────────────────────────────────────────────
// Use Kick's internal API used by their own frontend (not the public v2 API)
const TOP_STREAMERS = [
  { slug:'xqc',           name:'xQc'        },
  { slug:'adinross',      name:'AdinRoss'   },
  { slug:'trainwreckstv', name:'Trainwreck' },
  { slug:'kaicenat',      name:'KaiCenat'   },
  { slug:'speed',         name:'IShowSpeed' },
  { slug:'n3on',          name:'N3on'       },
  { slug:'jynxzi',        name:'Jynxzi'     },
];

async function getClipsForStreamer(slug, name) {
  // Try multiple Kick API approaches
  const attempts = [
    // Kick's actual clips API (used by their frontend)
    { url:`https://kick.com/api/v2/clips?channel=${slug}&sort=view_count&time=week&limit=10`, label:'v2-clips' },
    { url:`https://kick.com/api/v2/channels/${slug}/clips?sort=view_count&limit=10`, label:'v2-channel-clips' },
    { url:`https://kick.com/api/v1/video-clips?channel=${slug}&sort=view_count&limit=10`, label:'v1-clips' },
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': `https://kick.com/${slug}`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  for (const attempt of attempts) {
    try {
      const res = await axios.get(attempt.url, { headers, timeout:15000 });
      const data = res.data;
      const list = data.data || data.clips || data || [];
      if (Array.isArray(list) && list.length > 0) {
        addLog(`[Kick] ${name}: ${list.length} clips via ${attempt.label}`);
        return list
          .filter(c => (c.video_url || c.clip_url) && c.clip_share_enabled !== false)
          .filter(c => (c.duration || 30) <= 65)
          .map(c => ({
            id: c.id || c.clip_id,
            title: c.title || `${name} clip`,
            url: c.video_url || c.clip_url,
            views: c.view_count || 0,
            duration: c.duration || 30,
            streamerName: name,
            channel: slug,
          }))
          .filter(c => c.id && c.url);
      }
    } catch(e) {
      addLog(`[Kick] ${name} ${attempt.label} failed: ${e.response?.status||e.message}`);
    }
  }

  // yt-dlp fallback on individual known clip pages
  addLog(`[Kick] ${name}: trying yt-dlp fallback`);
  return await getClipsViaYtDlp(slug, name);
}

function getClipsViaYtDlp(slug, name) {
  return new Promise(resolve => {
    const tools = getTools();
    if (tools.ytdlp === 'NOT INSTALLED') { addLog('[yt-dlp] NOT INSTALLED — skipping'); resolve([]); return; }
    const cmd = `yt-dlp --flat-playlist --dump-json --playlist-end 5 --no-warnings "https://kick.com/${slug}/clips" 2>&1`;
    exec(cmd, { timeout:30000 }, (err, stdout) => {
      const lines = (stdout||'').split('\n').filter(l=>l.startsWith('{'));
      const clips = lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean)
        .map(c=>({ id:c.id, title:c.title||`${name} clip`, url:c.webpage_url||`https://kick.com/${slug}?clip=${c.id}`, views:c.view_count||0, duration:c.duration||30, streamerName:name, channel:slug }))
        .filter(c=>c.id&&(c.duration||30)<=65);
      addLog(`[yt-dlp] ${name}: ${clips.length} clips`);
      resolve(clips);
    });
  });
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────
function downloadClip(url, outputPath) {
  return new Promise((resolve, reject) => {
    const tools = getTools();
    if (tools.ytdlp !== 'NOT INSTALLED') {
      const cmd = `yt-dlp -f "best[ext=mp4][filesize<48M]/best[filesize<48M]/best" -o "${outputPath}" "${url}" --no-playlist -q --socket-timeout 30 2>&1`;
      exec(cmd, { timeout:90000 }, (err, out) => {
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) { resolve(); return; }
        // Try direct download
        directDownload(url, outputPath, resolve, reject);
      });
    } else {
      directDownload(url, outputPath, resolve, reject);
    }
  });
}

function directDownload(url, outputPath, resolve, reject) {
  axios({ url, responseType:'stream', timeout:60000,
    headers:{ 'User-Agent':'Mozilla/5.0', 'Referer':'https://kick.com/' }
  }).then(res => {
    const w = fs.createWriteStream(outputPath);
    res.data.pipe(w);
    w.on('finish', ()=>{ if(fs.existsSync(outputPath)&&fs.statSync(outputPath).size>5000)resolve(); else reject(new Error('File too small')); });
    w.on('error', reject);
  }).catch(reject);
}

// ── CAPTION ───────────────────────────────────────────────────────────────────
async function generateCaption(clip) {
  try {
    const msg = await client.messages.create({
      model:'claude-sonnet-4-20250514', max_tokens:200,
      system:'Write viral TikTok captions for gaming/streaming clips. Punchy, use emojis, under 100 chars. Credit the streamer.',
      messages:[{role:'user',content:`Caption for: "${clip.title}" by @${clip.streamerName} on Kick\nCAPTION: [punchy + emojis]\nHASHTAGS: [relevant tags]`}]
    });
    const t=msg.content[0].text;
    return {
      caption:((t.match(/CAPTION:\s*(.+)/)||[])[1]||`🔥 ${clip.title}`).trim()+` 📺@${clip.streamerName}`,
      hashtags:((t.match(/HASHTAGS:\s*(.+)/)||[])[1]||`#${clip.streamerName.toLowerCase()} #kick #gaming #fyp #viral`).trim()
    };
  } catch(e) {
    return { caption:`🔥 ${clip.title} 📺@${clip.streamerName}`, hashtags:`#${clip.streamerName.toLowerCase()} #kick #gaming #fyp #viral` };
  }
}

// ── TIKTOK ────────────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db=loadDB();
  const token=db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN;
  if(!token||token.length<10){addLog('[TikTok] No token — queued');return{success:false,reason:'no_token'};}
  try {
    const buf=fs.readFileSync(videoPath);
    const init=await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/',
      {post_info:{title:`${caption} ${hashtags}`.slice(0,150),privacy_level:'PUBLIC_TO_EVERYONE',disable_duet:false,disable_comment:false,disable_stitch:false},source_info:{source:'FILE_UPLOAD',video_size:buf.length}},
      {headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}}
    );
    await axios.put(init.data.data.upload_url,buf,{headers:{'Content-Type':'video/mp4','Content-Range':`bytes 0-${buf.length-1}/${buf.length}`}});
    addLog('[TikTok] ✓ Posted successfully');
    return{success:true};
  } catch(e){addLog('[TikTok] Failed: '+(e.response?.data?.error?.message||e.message));return{success:false,reason:e.message};}
}

// ── PROCESS ONE CLIP ──────────────────────────────────────────────────────────
async function processClip(clip) {
  addLog(`[Agent] Processing: "${clip.title}" by ${clip.streamerName}`);
  const { caption, hashtags } = await generateCaption(clip);
  const dir='./videos'; if(!fs.existsSync(dir))fs.mkdirSync(dir);
  const videoPath=path.join(dir,`${clip.id}.mp4`);
  await downloadClip(clip.url, videoPath);
  addLog(`[Agent] Downloaded ${Math.round(fs.statSync(videoPath).size/1024)}KB`);
  const result = await postToTikTok(videoPath, caption, hashtags);
  if(fs.existsSync(videoPath))fs.unlinkSync(videoPath);
  return { ...clip, caption, hashtags, success:result.success, reason:result.reason };
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function runAgent() {
  addLog('[Agent] Starting run');
  const db=loadDB();
  if(db.stats.lastReset!==new Date().toDateString()){db.stats.today=0;db.stats.lastReset=new Date().toDateString();}

  // Process manual queue first
  const manual = (db.manualQueue||[]).filter(c=>c.status==='queued');
  for (const clip of manual.slice(0,3)) {
    try {
      const result = await processClip(clip);
      clip.status = result.success?'posted':'failed';
      if(result.success){db.stats.totalPosted++;db.stats.today++;}
      db.posted.unshift({...clip,postedAt:new Date().toISOString()});
      saveDB(db);
      await new Promise(r=>setTimeout(r,15000));
    } catch(e) { clip.status='failed'; clip.error=e.message; saveDB(db); addLog('[Agent] Error: '+e.message); }
  }

  // Auto-discover from Kick
  const streamers = TOP_STREAMERS.slice(0,5);
  db.streamers=streamers; saveDB(db);
  let allClips=[];
  for(const s of streamers){
    const clips=await getClipsForStreamer(s.slug,s.name);
    allClips.push(...clips);
    await new Promise(r=>setTimeout(r,2000));
  }

  const postedIds=db.posted.map(p=>p.clipId||p.id);
  const newClips=allClips.filter(c=>c.id&&!postedIds.includes(c.id)).sort((a,b)=>b.views-a.views).slice(0,2);
  addLog(`[Agent] ${allClips.length} clips found, ${newClips.length} new`);

  for(const clip of newClips){
    try{
      const result=await processClip(clip);
      db.posted.unshift({clipId:clip.id,...clip,...result,postedAt:new Date().toISOString()});
      if(db.posted.length>100)db.posted=db.posted.slice(0,100);
      if(result.success){db.stats.totalPosted++;db.stats.today++;}
      saveDB(db);
      await new Promise(r=>setTimeout(r,20000));
    }catch(e){addLog('[Agent] Error: '+e.message);}
  }

  db.lastRun=new Date().toISOString(); saveDB(db);
  addLog(`[Agent] Done. Posted today: ${db.stats.today}`);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/', (req,res) => {
  const db=loadDB();
  const tools=getTools();
  res.send(`<!DOCTYPE html><html><head><title>Social Agent</title>
  <style>body{font-family:monospace;background:#060a1a;color:#0f0;padding:20px;max-width:900px;margin:0 auto}
  h1{color:#cc44ff}h2{color:#aaa;font-size:14px;margin-top:20px}
  .card{background:#0d1225;border:1px solid #cc44ff33;padding:14px;margin:10px 0;border-radius:4px}
  input,textarea{background:#0d1225;border:1px solid #cc44ff55;color:#fff;padding:8px;width:100%;margin:4px 0;font-family:monospace;border-radius:3px}
  button{background:#cc44ff22;border:1px solid #cc44ff;color:#cc44ff;padding:8px 16px;cursor:pointer;font-family:monospace;border-radius:3px;margin-top:6px}
  button:hover{background:#cc44ff44}.ok{color:#0f0}.warn{color:#ffa500}.err{color:#f44}
  .log{max-height:200px;overflow-y:auto;font-size:11px;color:#888}</style></head>
  <body><h1>🤖 SOCIAL AGENT</h1>
  <div class="card">
  <b>Tools:</b> yt-dlp: <span class="${tools.ytdlp==='NOT INSTALLED'?'err':'ok'}">${tools.ytdlp}</span> | 
  ffmpeg: <span class="${tools.ffmpeg==='NOT INSTALLED'?'err':'ok'}">${tools.ffmpeg==='NOT INSTALLED'?'NOT INSTALLED':'OK'}</span><br>
  <b>Posted today:</b> ${db.stats.today} | <b>Total:</b> ${db.stats.totalPosted} | <b>Last run:</b> ${db.lastRun?db.lastRun.slice(0,19):'never'}<br>
  <b>TikTok:</b> <span class="${(db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN)?'ok':'warn'}">${(db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN)?'CONNECTED':'NOT CONNECTED — <a href="/tiktok/connect" style="color:#cc44ff">Connect TikTok</a>'}</span>
  </div>
  <div class="card">
  <h2>ADD CLIP MANUALLY</h2>
  <p style="color:#888;font-size:11px">Paste a Kick clip URL to queue it for posting</p>
  <input type="text" id="clipUrl" placeholder="https://kick.com/xqc?clip=clip_01..."/>
  <input type="text" id="clipName" placeholder="Streamer name (e.g. xQc)"/>
  <button onclick="addClip()">ADD TO QUEUE</button>
  <span id="addResult"></span>
  </div>
  <div class="card">
  <h2>QUEUE (${(db.manualQueue||[]).filter(c=>c.status==='queued').length} pending)</h2>
  ${(db.manualQueue||[]).slice(0,5).map(c=>`<div style="padding:4px 0;border-bottom:1px solid #1a1a2e">${c.status==='queued'?'⏳':c.status==='posted'?'✅':'❌'} ${c.title||c.url} — ${c.streamer||'unknown'}</div>`).join('')||'<span style="color:#444">No clips queued</span>'}
  </div>
  <div class="card">
  <h2>RECENT POSTS</h2>
  ${db.posted.slice(0,5).map(p=>`<div style="padding:4px 0;border-bottom:1px solid #1a1a2e">${p.success?'✅':'📋'} ${p.title||p.clipId} — @${p.streamerName||p.streamer}</div>`).join('')||'<span style="color:#444">No posts yet</span>'}
  </div>
  <div class="card">
  <h2>LOG</h2><div class="log">${(db.log||[]).map(l=>`<div>${l}</div>`).join('')}</div>
  </div>
  <button onclick="fetch('/run-now',{method:'POST'}).then(()=>setTimeout(()=>location.reload(),2000))">▶ RUN NOW</button>
  <script>
  async function addClip(){
    const url=document.getElementById('clipUrl').value.trim();
    const name=document.getElementById('clipName').value.trim()||'Unknown';
    if(!url)return;
    const r=await fetch('/add-clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,streamer:name})});
    const d=await r.json();
    document.getElementById('addResult').textContent=' '+d.message;
    setTimeout(()=>location.reload(),1500);
  }
  setTimeout(()=>location.reload(),30000);
  </script></body></html>`);
});

app.get('/status', (req,res) => {
  const db=loadDB();
  res.json({ status:'running', tools:getTools(), streamers:db.streamers, stats:db.stats, lastRun:db.lastRun, recentPosts:db.posted.slice(0,5), queue:(db.manualQueue||[]).filter(c=>c.status==='queued').slice(0,5), log:(db.log||[]).slice(0,20) });
});

app.get('/debug', (req,res) => {
  const tools=getTools();
  // Test yt-dlp on a known working URL
  exec('yt-dlp --version 2>&1 && yt-dlp --flat-playlist --dump-json --playlist-end 1 "https://kick.com/xqc/clips" 2>&1', {timeout:30000}, (err,out) => {
    res.json({ tools, ytdlpTest: (out||'').slice(0,500), err: err?.message });
  });
});

app.post('/add-clip', (req,res) => {
  const { url, streamer, title } = req.body;
  if (!url) return res.status(400).json({ error:'URL required' });
  const db=loadDB();
  db.manualQueue=db.manualQueue||[];
  const id = 'manual_'+Date.now();
  db.manualQueue.unshift({ id, clipId:id, url, streamer:streamer||'Unknown', title:title||url.split('/').pop()||'Clip', status:'queued', addedAt:new Date().toISOString() });
  if(db.manualQueue.length>50)db.manualQueue=db.manualQueue.slice(0,50);
  saveDB(db);
  addLog(`[Queue] Added: ${url}`);
  res.json({ success:true, message:'Clip added to queue' });
});

app.get('/posted', (req,res) => res.json(loadDB().posted.slice(0,20)));
app.get('/queue',  (req,res) => res.json((loadDB().manualQueue||[]).slice(0,20)));
app.post('/run-now', (req,res) => { res.json({message:'started'}); runAgent().catch(e=>addLog('[Agent] Error: '+e.message)); });

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
      client_key:process.env.TIKTOK_CLIENT_KEY,client_secret:process.env.TIKTOK_CLIENT_SECRET,
      code,grant_type:'authorization_code',redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`
    });
    const db=loadDB(); db.tiktokToken=t.data.access_token; db.tiktokRefresh=t.data.refresh_token; saveDB(db);
    addLog('[TikTok] OAuth complete');
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! Close this tab.</h2>');
  }catch(e){res.status(500).send('OAuth error: '+e.message);}
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  addLog(`Social Agent on port ${PORT}`);
  addLog(`Tools: ${JSON.stringify(getTools())}`);
  setTimeout(()=>runAgent().catch(e=>addLog('[Agent] Startup error: '+e.message)), 8000);
});
cron.schedule('0 */2 * * *', ()=>runAgent().catch(e=>addLog('[Agent] Cron error: '+e.message)));
