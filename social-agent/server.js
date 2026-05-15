require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// File upload setup — max 100MB
const upload = multer({
  dest: './uploads/',
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Video files only'));
  }
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── STATE ─────────────────────────────────────────────────────────────────────
const DB_FILE = './social_state.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch { return { posted:[], queue:[], stats:{totalPosted:0,today:0,lastReset:new Date().toDateString()}, lastRun:null, log:[] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function addLog(msg) {
  console.log(msg);
  try {
    const db = loadDB(); db.log = db.log||[];
    db.log.unshift(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
    if (db.log.length > 100) db.log = db.log.slice(0,100);
    saveDB(db);
  } catch(e) {}
}

// ── YT-DLP PATH ───────────────────────────────────────────────────────────────
const YTDLP = fs.existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';

function checkTools() {
  const r = {};
  try { r.ytdlp = require('child_process').execSync(`${YTDLP} --version 2>&1`).toString().trim(); } catch(e) { r.ytdlp = 'not found'; }
  try { r.ffmpeg = require('child_process').execSync('ffmpeg -version 2>&1 | head -1').toString().trim().slice(0,50); } catch(e) { r.ffmpeg = 'not found'; }
  return r;
}

// ── DOWNLOAD VIA YT-DLP ───────────────────────────────────────────────────────
function downloadUrl(url, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `${YTDLP} -f "best[ext=mp4][filesize<90M]/best[filesize<90M]/best" -o "${outputPath}" "${url}" --no-playlist -q --socket-timeout 60 2>&1`;
    addLog(`[DL] ${url.slice(0,55)}`);
    exec(cmd, { timeout: 120000 }, (err, stdout) => {
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
        addLog(`[DL] ✓ ${Math.round(fs.statSync(outputPath).size/1024)}KB`);
        resolve(); return;
      }
      reject(new Error(`yt-dlp failed: ${(stdout||'').slice(0,100)}`));
    });
  });
}

// ── CAPTION ───────────────────────────────────────────────────────────────────
async function generateCaption(title, streamer) {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 200,
      system: 'Write viral TikTok captions for gaming/streaming clips. Punchy, emojis, under 100 chars. Credit the streamer.',
      messages:[{role:'user', content:`Caption for Kick clip: "${title}" by @${streamer}\nCAPTION: [punchy text + emojis]\nHASHTAGS: [tags including #${streamer.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral]`}]
    });
    const t = msg.content[0].text;
    return {
      caption: ((t.match(/CAPTION:\s*(.+)/)||[])[1]||`🔥 ${title.slice(0,60)}`).trim() + ` 📺@${streamer}`,
      hashtags: ((t.match(/HASHTAGS:\s*(.+)/)||[])[1]||`#${streamer.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral`).trim()
    };
  } catch(e) {
    return {
      caption: `🔥 ${title.slice(0,60)} 📺@${streamer}`,
      hashtags: `#${streamer.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral`
    };
  }
}

// ── TIKTOK POST ───────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db = loadDB();
  const token = db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!token || token.length < 10) {
    addLog('[TikTok] No token — video saved, will post when connected');
    return { success: false, reason: 'no_token' };
  }
  try {
    const buf = fs.readFileSync(videoPath);
    const init = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      { post_info:{ title:`${caption} ${hashtags}`.slice(0,150), privacy_level:'PUBLIC_TO_EVERYONE', disable_duet:false, disable_comment:false, disable_stitch:false }, source_info:{ source:'FILE_UPLOAD', video_size:buf.length } },
      { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    await axios.put(init.data.data.upload_url, buf, {
      headers:{ 'Content-Type':'video/mp4', 'Content-Range':`bytes 0-${buf.length-1}/${buf.length}` }
    });
    addLog('[TikTok] ✓ Posted!');
    return { success: true };
  } catch(e) {
    addLog('[TikTok] Failed: '+(e.response?.data?.error?.message||e.message).slice(0,100));
    return { success: false, reason: e.message };
  }
}

// ── PROCESS VIDEO FILE ────────────────────────────────────────────────────────
async function processVideoFile(videoPath, title, streamer) {
  addLog(`[Agent] Processing: "${title}" by @${streamer}`);
  const { caption, hashtags } = await generateCaption(title, streamer);
  addLog(`[Agent] Caption: ${caption.slice(0,60)}`);
  const result = await postToTikTok(videoPath, caption, hashtags);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  return { caption, hashtags, ...result };
}

// ── PROCESS URL QUEUE ─────────────────────────────────────────────────────────
async function processQueue() {
  addLog('[Agent] Running queue');
  const db = loadDB();
  if (db.stats.lastReset !== new Date().toDateString()) { db.stats.today=0; db.stats.lastReset=new Date().toDateString(); }

  const pending = (db.queue||[]).filter(c => c.status==='queued');
  addLog(`[Agent] ${pending.length} items in queue`);

  for (const item of pending.slice(0,3)) {
    try {
      const dir = './videos'; if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      const videoPath = path.join(dir, `${Date.now()}.mp4`);

      if (item.localPath && fs.existsSync(item.localPath)) {
        // Already uploaded file
        fs.renameSync(item.localPath, videoPath);
      } else if (item.url) {
        // Download from URL
        await downloadUrl(item.url, videoPath);
      } else {
        item.status = 'failed'; item.error = 'No URL or file'; saveDB(db); continue;
      }

      const result = await processVideoFile(videoPath, item.title||'Kick Clip', item.streamer||'Unknown');
      item.status = result.success ? 'posted' : (result.reason==='no_token' ? 'ready' : 'failed');
      item.caption = result.caption; item.hashtags = result.hashtags;
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      db.posted.unshift({ ...item, postedAt: new Date().toISOString(), success: result.success });
      if (db.posted.length > 100) db.posted = db.posted.slice(0,100);
      saveDB(db);
      if (pending.length > 1) await new Promise(r=>setTimeout(r,15000));
    } catch(e) {
      item.status = 'failed'; item.error = e.message;
      addLog('[Agent] Error: '+e.message);
      saveDB(db);
    }
  }

  db.lastRun = new Date().toISOString(); saveDB(db);
  addLog(`[Agent] Done. Posted today: ${db.stats.today}`);
}

// ── WEB UI ────────────────────────────────────────────────────────────────────
app.get('/', (req,res) => {
  const db = loadDB();
  const tools = checkTools();
  const tiktokOk = !!(db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN);
  const pending = (db.queue||[]).filter(c=>c.status==='queued').length;

  res.send(`<!DOCTYPE html><html><head>
  <title>Social Agent</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
  *{box-sizing:border-box}
  body{font-family:monospace;background:#060a1a;color:#ccc;padding:20px;max-width:820px;margin:0 auto;font-size:13px}
  h1{color:#cc44ff;margin-bottom:4px;font-size:20px}
  h2{color:#666;font-size:10px;letter-spacing:2px;margin:16px 0 8px;text-transform:uppercase}
  .card{background:#0d1225;border:1px solid rgba(200,68,255,0.18);padding:16px;margin:10px 0;border-radius:4px}
  .stats{display:flex;flex-wrap:wrap;gap:16px;font-size:12px}
  .stat b{color:#cc44ff}
  input,select{background:#060a1a;border:1px solid #cc44ff44;color:#fff;padding:9px 11px;width:100%;margin:4px 0;font-family:monospace;border-radius:3px;font-size:12px}
  .row{display:flex;gap:8px}
  .row input{flex:1}
  .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  button{background:rgba(200,68,255,0.12);border:1px solid #cc44ff;color:#cc44ff;padding:9px 18px;cursor:pointer;font-family:monospace;border-radius:3px;font-size:11px}
  button:hover{background:rgba(200,68,255,0.25)}
  .g{background:rgba(0,255,136,0.08);border-color:#00ff88;color:#00ff88}
  .g:hover{background:rgba(0,255,136,0.2)}
  .ok{color:#00ff88}.warn{color:#ffa500}.err{color:#ff4444}
  .log{max-height:200px;overflow-y:auto;font-size:10px;color:#444;line-height:1.7;margin-top:6px}
  .item{padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px}
  .tag{display:inline-block;padding:1px 6px;border-radius:2px;font-size:9px;margin-right:4px}
  .t-posted{background:rgba(0,255,136,0.1);color:#00ff88}
  .t-queued{background:rgba(255,200,0,0.1);color:#ffc800}
  .t-ready{background:rgba(0,180,255,0.1);color:#00b4ff}
  .t-failed{background:rgba(255,60,60,0.1);color:#ff6060}
  a{color:#cc44ff}
  #msg{font-size:11px;margin-top:8px;min-height:18px}
  .drop-zone{border:2px dashed #cc44ff44;border-radius:4px;padding:30px;text-align:center;cursor:pointer;color:#555;font-size:12px;margin:8px 0;transition:all .2s}
  .drop-zone:hover,.drop-zone.drag{border-color:#cc44ff;color:#cc44ff;background:rgba(200,68,255,0.05)}
  .prog{display:none;background:#0d1225;border:1px solid #cc44ff44;border-radius:3px;height:6px;margin-top:8px;overflow:hidden}
  .prog-bar{height:100%;background:#cc44ff;width:0%;transition:width .3s}
  .tools{font-size:10px;color:#444;margin-top:8px}
  </style></head><body>
  <h1>🤖 SOCIAL AGENT</h1>
  <p style="color:#444;font-size:10px;margin-bottom:12px">Autonomous TikTok clip poster for Kick content</p>

  <div class="card">
    <div class="stats">
      <span class="stat">📊 Today: <b>${db.stats.today}</b></span>
      <span class="stat">✅ Total: <b>${db.stats.totalPosted}</b></span>
      <span class="stat">⏳ Queue: <b>${pending}</b></span>
      <span class="stat">⏱ Last: <b>${db.lastRun?db.lastRun.slice(11,19):'never'}</b></span>
      <span class="stat">TikTok: <b class="${tiktokOk?'ok':'warn'}">${tiktokOk?'✓ Connected':'<a href="/tiktok/connect">Connect →</a>'}</b></span>
    </div>
    <div class="tools">yt-dlp: <span class="${tools.ytdlp==='not found'?'err':'ok'}">${tools.ytdlp}</span> &nbsp;|&nbsp; ffmpeg: <span class="${tools.ffmpeg==='not found'?'err':'ok'}">${tools.ffmpeg==='not found'?'not found':'✓'}</span></div>
  </div>

  <div class="card">
    <h2>📁 Upload Video File</h2>
    <p style="color:#555;font-size:10px;margin-bottom:10px">Download a clip from Kick on your computer, then upload it here. Agent captions and posts to TikTok.</p>
    <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
      Drop MP4 here or click to browse<br>
      <span style="font-size:10px;color:#333">Max 100MB · MP4, MOV</span>
    </div>
    <input type="file" id="fileInput" accept="video/*" style="display:none" onchange="handleFile(this.files[0])"/>
    <div class="row" style="margin-top:8px">
      <input id="ut" placeholder="Video title or clip description"/>
      <input id="us" placeholder="Streamer name" style="max-width:180px"/>
    </div>
    <div class="btns">
      <button class="g" id="uploadBtn" onclick="uploadFile()" disabled>📤 Upload & Queue</button>
    </div>
    <div class="prog" id="prog"><div class="prog-bar" id="progBar"></div></div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <h2>🔗 Add by URL</h2>
    <p style="color:#555;font-size:10px;margin-bottom:10px">Works with YouTube, Twitter/X clips, and some Kick URLs. Kick direct downloads may be blocked.</p>
    <input id="cu" placeholder="https://youtube.com/... or https://twitter.com/... or https://kick.com/..."/>
    <div class="row" style="margin-top:4px">
      <input id="ct" placeholder="Video title"/>
      <input id="cs" placeholder="Streamer name" style="max-width:180px"/>
    </div>
    <div class="btns">
      <button onclick="addUrl()">➕ Add URL to Queue</button>
      <button class="g" onclick="runNow()">▶ Run Agent Now</button>
    </div>
  </div>

  <div class="card">
    <h2>Queue (${pending} pending)</h2>
    ${(db.queue||[]).slice(0,8).map(c=>`
      <div class="item">
        <span class="tag t-${c.status==='queued'?'queued':c.status==='posted'?'posted':c.status==='ready'?'ready':'failed'}">${c.status}</span>
        <b style="color:#cc44ff">@${c.streamer||'?'}</b> — ${(c.title||'').slice(0,55)}
      </div>`).join('')||'<div style="color:#333;padding:8px 0">No clips queued — upload a video above</div>'}
  </div>

  <div class="card">
    <h2>Recent Posts</h2>
    ${db.posted.slice(0,6).map(p=>`
      <div class="item">
        <span class="tag t-${p.success?'posted':'ready'}">${p.success?'posted':'saved'}</span>
        <b style="color:#cc44ff">@${p.streamer||p.streamerName||'?'}</b> — ${(p.title||'').slice(0,55)}
        ${p.caption?`<div style="color:#555;font-size:10px;margin-top:2px">${p.caption.slice(0,80)}</div>`:''}
      </div>`).join('')||'<div style="color:#333;padding:8px 0">No posts yet</div>'}
  </div>

  <div class="card">
    <h2>Log</h2>
    <div class="log">${(db.log||[]).map(l=>`<div>${l}</div>`).join('')||'<span style="color:#333">No activity yet</span>'}</div>
  </div>

  <script>
  let selectedFile = null;

  // Drag & drop
  const dz = document.getElementById('dropZone');
  dz.addEventListener('dragover', e=>{e.preventDefault();dz.classList.add('drag');});
  dz.addEventListener('dragleave', ()=>dz.classList.remove('drag'));
  dz.addEventListener('drop', e=>{e.preventDefault();dz.classList.remove('drag');if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});

  function handleFile(file) {
    if (!file) return;
    selectedFile = file;
    document.getElementById('dropZone').textContent = '✓ ' + file.name + ' (' + Math.round(file.size/1024/1024*10)/10 + 'MB)';
    document.getElementById('uploadBtn').disabled = false;
    if (!document.getElementById('ut').value) document.getElementById('ut').value = file.name.replace(/\.[^.]+$/,'');
  }

  async function uploadFile() {
    if (!selectedFile) return;
    const title = document.getElementById('ut').value.trim() || selectedFile.name;
    const streamer = document.getElementById('us').value.trim() || 'Unknown';
    const msg = document.getElementById('msg');
    const btn = document.getElementById('uploadBtn');
    const prog = document.getElementById('prog');
    const bar = document.getElementById('progBar');

    btn.disabled = true; btn.textContent = 'Uploading...';
    prog.style.display = 'block'; bar.style.width = '10%';
    msg.innerHTML = 'Uploading video...';

    const formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('title', title);
    formData.append('streamer', streamer);

    try {
      bar.style.width = '50%';
      const r = await fetch('/upload', { method:'POST', body:formData });
      bar.style.width = '100%';
      const d = await r.json();
      if (d.success) {
        msg.innerHTML = '<span class="ok">✓ Uploaded! Running agent...</span>';
        fetch('/run-now', {method:'POST'});
        setTimeout(()=>location.reload(), 4000);
      } else {
        msg.innerHTML = '<span class="err">Error: ' + d.error + '</span>';
        btn.disabled = false; btn.textContent = '📤 Upload & Queue';
      }
    } catch(e) {
      msg.innerHTML = '<span class="err">Upload failed: ' + e.message + '</span>';
      btn.disabled = false; btn.textContent = '📤 Upload & Queue';
    }
  }

  async function addUrl() {
    const url = document.getElementById('cu').value.trim();
    const title = document.getElementById('ct').value.trim() || 'Kick Clip';
    const streamer = document.getElementById('cs').value.trim() || 'Unknown';
    if (!url) { document.getElementById('msg').innerHTML = '<span class="err">Enter a URL</span>'; return; }
    const r = await fetch('/add-url', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url,title,streamer})});
    const d = await r.json();
    document.getElementById('msg').innerHTML = d.success ? '<span class="ok">✓ Added to queue</span>' : '<span class="err">' + d.error + '</span>';
    if (d.success) { document.getElementById('cu').value=''; setTimeout(()=>location.reload(),2000); }
  }

  async function runNow() {
    document.getElementById('msg').innerHTML = '<span class="ok">▶ Agent started...</span>';
    await fetch('/run-now', {method:'POST'});
    setTimeout(()=>location.reload(), 6000);
  }

  setTimeout(()=>location.reload(), 30000);
  </script></body></html>`);
});

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get('/status', (req,res) => {
  const db = loadDB();
  res.json({ status:'running', tools:checkTools(), stats:db.stats, lastRun:db.lastRun, pending:(db.queue||[]).filter(c=>c.status==='queued').length, recentPosts:db.posted.slice(0,5), log:(db.log||[]).slice(0,15) });
});

// Upload video file
app.post('/upload', upload.single('video'), async (req,res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});
  const { title, streamer } = req.body;
  const db = loadDB(); db.queue = db.queue||[];
  const item = {
    id: 'upload_'+Date.now(),
    title: title||req.file.originalname||'Kick Clip',
    streamer: streamer||'Unknown',
    localPath: req.file.path,
    status: 'queued',
    addedAt: new Date().toISOString(),
    size: req.file.size
  };
  db.queue.unshift(item);
  if (db.queue.length > 50) db.queue = db.queue.slice(0,50);
  saveDB(db);
  addLog(`[Upload] ${req.file.originalname} (${Math.round(req.file.size/1024)}KB) by @${streamer}`);
  res.json({success:true, id:item.id});
});

// Add URL to queue
app.post('/add-url', (req,res) => {
  const {url,title,streamer} = req.body;
  if (!url) return res.status(400).json({error:'URL required'});
  const db = loadDB(); db.queue = db.queue||[];
  db.queue.unshift({ id:'url_'+Date.now(), url, title:title||'Kick Clip', streamer:streamer||'Unknown', status:'queued', addedAt:new Date().toISOString() });
  if (db.queue.length > 50) db.queue = db.queue.slice(0,50);
  saveDB(db);
  addLog(`[Queue] URL: ${url.slice(0,55)}`);
  res.json({success:true});
});

app.get('/posted', (req,res) => res.json(loadDB().posted.slice(0,20)));
app.get('/queue',  (req,res) => res.json((loadDB().queue||[]).slice(0,20)));

app.post('/run-now', (req,res) => {
  res.json({message:'Agent started'});
  processQueue().catch(e=>addLog('[Agent] Error: '+e.message));
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
  try {
    const t=await axios.post('https://open.tiktokapis.com/v2/oauth/token/',{
      client_key:process.env.TIKTOK_CLIENT_KEY, client_secret:process.env.TIKTOK_CLIENT_SECRET,
      code, grant_type:'authorization_code',
      redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`
    });
    const db=loadDB(); db.tiktokToken=t.data.access_token; db.tiktokRefresh=t.data.refresh_token; saveDB(db);
    addLog('[TikTok] ✓ OAuth complete');
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! Close this tab.</h2>');
  } catch(e) { res.status(500).send('Error: '+e.message); }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  addLog(`Social Agent on port ${PORT}`);
  const t = checkTools();
  addLog(`Tools: yt-dlp=${t.ytdlp} ffmpeg=${t.ffmpeg==='not found'?'not found':'ok'}`);
  setTimeout(()=>processQueue().catch(e=>addLog('[Agent] Startup: '+e.message)), 8000);
});
cron.schedule('0 */2 * * *', ()=>{ addLog('[Cron] Scheduled run'); processQueue().catch(e=>addLog('[Cron] Error: '+e.message)); });
