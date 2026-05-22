require('dotenv').config();

// Route ALL outbound requests through proxy at Node.js level
if (process.env.PROXY_URL) {
  process.env.HTTP_PROXY  = process.env.PROXY_URL;
  process.env.HTTPS_PROXY = process.env.PROXY_URL;
  process.env.GLOBAL_AGENT_HTTP_PROXY  = process.env.PROXY_URL;
  process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.PROXY_URL;
  try { require('global-agent').bootstrap(); console.log('[Proxy] global-agent active: '+process.env.PROXY_URL.slice(0,30)); }
  catch(e) { console.log('[Proxy] using env vars only'); }
}

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

const upload = multer({ dest:'./uploads/', limits:{ fileSize:200*1024*1024 }, fileFilter:(req,file,cb)=>{ if(file.mimetype.startsWith('video/'))cb(null,true); else cb(new Error('Video only')); } });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PROXY ─────────────────────────────────────────────────────────────────────
// DataImpulse requires HttpsProxyAgent (per their official Node.js docs)
const { HttpsProxyAgent } = require('https-proxy-agent');
const PROXY_URL = process.env.PROXY_URL;
function getProxyAgent() {
  if (!PROXY_URL) return null;
  try { return new HttpsProxyAgent(PROXY_URL); } catch(e) { return null; }
}
function pAxios(config) {
  const agent = getProxyAgent();
  if (!agent) return axios(config);
  return axios({ ...config, httpsAgent: agent, proxy: false });
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const DB_FILE = './social_state.json';
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return { posted:[], queue:[], stats:{totalPosted:0,today:0,lastReset:new Date().toDateString()}, lastRun:null, log:[] }; } }
function saveDB(db) { fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2)); }
function addLog(msg) {
  console.log(msg);
  try { const db=loadDB(); db.log=db.log||[]; db.log.unshift(`[${new Date().toISOString().slice(11,19)}] ${msg}`); if(db.log.length>100)db.log=db.log.slice(0,100); saveDB(db); } catch(e) {}
}

const YTDLP = fs.existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';
function checkTools() {
  const r={};
  try { r.ytdlp=require('child_process').execSync(`${YTDLP} --version 2>&1`).toString().trim(); } catch(e){r.ytdlp='not found';}
  try { r.ffmpeg=require('child_process').execSync('ffmpeg -version 2>&1|head -1').toString().trim().slice(0,40); } catch(e){r.ffmpeg='not found';}
  r.proxy = PROXY_URL ? '✓ connected' : 'not set';
  return r;
}

// ── KICK AUTO-DISCOVERY ───────────────────────────────────────────────────────
const TOP_STREAMERS = [
  { slug:'xqc',name:'xQc' }, { slug:'adinross',name:'AdinRoss' },
  { slug:'trainwreckstv',name:'Trainwreck' }, { slug:'kaicenat',name:'KaiCenat' },
  { slug:'speed',name:'IShowSpeed' }, { slug:'n3on',name:'N3on' },
  { slug:'jynxzi',name:'Jynxzi' },
];

async function getKickClips(slug, name) {
  const urls = [
    `https://kick.com/api/v2/clips?channel=${slug}&sort=view_count&time=week&limit=10`,
    `https://kick.com/api/v2/channels/${slug}/clips?sort=view_count&limit=10`,
  ];
  for (const url of urls) {
    try {
      const res = await pAxios({ url, method:'GET', timeout:15000,
        headers:{ 'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept':'application/json', 'Referer':`https://kick.com/${slug}` }
      });
      const list = res.data?.data || res.data || [];
      if (Array.isArray(list) && list.length > 0) {
        const clips = list
          .filter(c => c.clip_share_enabled !== false && (c.video_url||c.clip_url))
          .filter(c => (c.duration||30) <= 65)
          .map(c => ({ id:'kick_'+(c.id||c.clip_id), title:c.title||`${name} clip`, url:c.video_url||c.clip_url, views:c.view_count||0, duration:c.duration||30, streamerName:name, channel:slug }))
          .filter(c => c.id && c.url);
        addLog(`[Kick] ${name}: ${clips.length} clips via proxy`);
        return clips;
      }
    } catch(e) { addLog(`[Kick] ${name} failed: ${e.response?.status||e.message.slice(0,50)}`); }
  }
  return [];
}

// ── TIKTOK CLIP DISCOVERY ─────────────────────────────────────────────────────
async function getTikTokClips() {
  // Search TikTok for Kick clips via proxy
  const queries = ['xQc kick clip','AdinRoss kick','IShowSpeed kick','KaiCenat kick','kick.com funny'];
  let clips = [];
  for (const q of queries) {
    try {
      // Use yt-dlp with proxy to search TikTok
      const proxyArg = PROXY_URL ? `--proxy "${PROXY_URL}"` : '';
      const cmd = `${YTDLP} --flat-playlist --dump-json --playlist-end 3 --no-warnings ${proxyArg} "https://www.tiktok.com/search?q=${encodeURIComponent(q)}" 2>&1`;
      const result = await new Promise(resolve => exec(cmd, {timeout:30000}, (e,o)=>resolve(o||'')));
      const lines = result.split('\n').filter(l=>l.trim().startsWith('{'));
      const found = lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean)
        .filter(c=>c.id&&(c.duration||30)<=65)
        .map(c=>({ id:'tt_'+c.id, title:c.title||q, url:c.webpage_url||`https://www.tiktok.com/@${c.uploader}/video/${c.id}`, views:c.view_count||0, duration:c.duration||30, streamerName:c.uploader||'TikTok', channel:c.uploader||'tiktok' }));
      if (found.length) addLog(`[TikTok] "${q}": ${found.length} clips`);
      clips.push(...found);
    } catch(e) { addLog(`[TikTok] search error: ${e.message.slice(0,50)}`); }
    await new Promise(r=>setTimeout(r,1500));
  }
  return clips;
}

// ── AUTO-DISCOVER ─────────────────────────────────────────────────────────────
async function autoDiscover() {
  addLog('[Auto] Discovering clips from Kick + TikTok via proxy...');
  const db = loadDB();
  const postedIds = db.posted.map(p=>p.id||p.clipId);

  let allClips = [];

  // Kick clips via proxy
  for (const s of TOP_STREAMERS.slice(0,5)) {
    const clips = await getKickClips(s.slug, s.name);
    allClips.push(...clips);
    await new Promise(r=>setTimeout(r,1500));
  }

  // TikTok clips via proxy + yt-dlp
  const ttClips = await getTikTokClips();
  allClips.push(...ttClips);

  addLog(`[Auto] Total: ${allClips.length} clips found`);

  const newClips = allClips.filter(c=>!postedIds.includes(c.id)).sort((a,b)=>b.views-a.views).slice(0,3);
  addLog(`[Auto] ${newClips.length} new clips added to queue`);

  db.queue = db.queue||[];
  for (const clip of newClips) {
    db.queue.unshift({...clip, status:'queued', addedAt:new Date().toISOString(), auto:true});
  }
  if (db.queue.length>50) db.queue=db.queue.slice(0,50);
  saveDB(db);
  return newClips.length;
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────
function downloadUrl(url, outputPath) {
  return new Promise((resolve, reject) => {
    const proxyArg = PROXY_URL ? `--proxy "${PROXY_URL}"` : '';
    const cmd = `${YTDLP} -f "best[ext=mp4][filesize<90M]/best[filesize<90M]/best" -o "${outputPath}" "${url}" --no-playlist -q --socket-timeout 60 ${proxyArg} 2>&1`;
    addLog(`[DL] ${url.slice(0,60)}`);
    exec(cmd, {timeout:120000}, async (err, stdout) => {
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
        addLog(`[DL] ✓ ${Math.round(fs.statSync(outputPath).size/1024)}KB`);
        resolve(); return;
      }
      // Direct download via proxy
      addLog(`[DL] yt-dlp failed, trying direct via proxy...`);
      try {
        const res = await pAxios({ url, method:'GET', responseType:'stream', timeout:90000, headers:{'User-Agent':'Mozilla/5.0','Referer':'https://kick.com/'} });
        const w = fs.createWriteStream(outputPath);
        res.data.pipe(w);
        w.on('finish', ()=>{ if(fs.existsSync(outputPath)&&fs.statSync(outputPath).size>5000){addLog(`[DL] ✓ Direct ${Math.round(fs.statSync(outputPath).size/1024)}KB`);resolve();}else reject(new Error('File too small')); });
        w.on('error', reject);
      } catch(e2) { reject(new Error('All download methods failed: '+e2.message)); }
    });
  });
}

// ── CAPTION ───────────────────────────────────────────────────────────────────
async function generateCaption(title, streamer) {
  try {
    const msg = await client.messages.create({
      model:'claude-sonnet-4-20250514', max_tokens:200,
      system:'Write viral TikTok captions for gaming/streaming clips. Punchy, emojis, under 100 chars. Credit the streamer.',
      messages:[{role:'user',content:`Caption for clip: "${title}" by @${streamer}\nCAPTION: [text+emojis]\nHASHTAGS: [tags including #${streamer.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral]`}]
    });
    const t=msg.content[0].text;
    return {
      caption:((t.match(/CAPTION:\s*(.+)/)||[])[1]||`🔥 ${title.slice(0,50)}`).trim()+` 📺@${streamer}`,
      hashtags:((t.match(/HASHTAGS:\s*(.+)/)||[])[1]||`#${streamer.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp #viral`).trim()
    };
  } catch(e) { return {caption:`🔥 ${title.slice(0,50)} 📺@${streamer}`,hashtags:`#${streamer.toLowerCase().replace(/\s/g,'')} #kick #gaming #fyp`}; }
}

// ── TIKTOK POST ───────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db=loadDB();
  const token=db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN;
  if(!token||token.length<10){addLog('[TikTok] No token');return{success:false,reason:'no_token'};}
  try {
    const buf=fs.readFileSync(videoPath);
    const init=await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/',
      {post_info:{title:`${caption} ${hashtags}`.slice(0,150),privacy_level:'PUBLIC_TO_EVERYONE',disable_duet:false,disable_comment:false,disable_stitch:false},source_info:{source:'FILE_UPLOAD',video_size:buf.length}},
      {headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}}
    );
    await axios.put(init.data.data.upload_url,buf,{headers:{'Content-Type':'video/mp4','Content-Range':`bytes 0-${buf.length-1}/${buf.length}`}});
    addLog('[TikTok] ✓ Posted!');
    return{success:true};
  } catch(e){addLog('[TikTok] Failed: '+(e.response?.data?.error?.message||e.message).slice(0,100));return{success:false,reason:e.message};}
}

// ── PROCESS QUEUE ─────────────────────────────────────────────────────────────
async function processQueue() {
  addLog('[Agent] Processing queue');
  const db=loadDB();
  if(db.stats.lastReset!==new Date().toDateString()){db.stats.today=0;db.stats.lastReset=new Date().toDateString();}
  const pending=(db.queue||[]).filter(c=>c.status==='queued');
  addLog(`[Agent] ${pending.length} items pending`);
  for (const item of pending.slice(0,3)) {
    try {
      const {caption,hashtags}=await generateCaption(item.title||'Clip',item.streamerName||item.streamer||'Kick');
      const dir='./videos'; if(!fs.existsSync(dir))fs.mkdirSync(dir);
      const videoPath=path.join(dir,`${String(item.id||Date.now()).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)}.mp4`);
      if(item.localPath&&fs.existsSync(item.localPath)) fs.renameSync(item.localPath,videoPath);
      else if(item.url) await downloadUrl(item.url,videoPath);
      else {item.status='failed';saveDB(db);continue;}
      const result=await postToTikTok(videoPath,caption,hashtags);
      item.status=result.success?'posted':result.reason==='no_token'?'ready':'failed';
      item.caption=caption;item.hashtags=hashtags;
      if(result.success){db.stats.totalPosted++;db.stats.today++;}
      db.posted.unshift({...item,postedAt:new Date().toISOString(),success:result.success});
      if(db.posted.length>100)db.posted=db.posted.slice(0,100);
      saveDB(db);
      if(fs.existsSync(videoPath))fs.unlinkSync(videoPath);
      if(pending.length>1)await new Promise(r=>setTimeout(r,15000));
    } catch(e){item.status='failed';item.error=e.message;addLog('[Agent] Error: '+e.message);saveDB(db);}
  }
  db.lastRun=new Date().toISOString();saveDB(db);
  addLog(`[Agent] Done. Posted today: ${db.stats.today}`);
}

async function fullRun() {
  await autoDiscover();
  await processQueue();
}

// ── WEB UI ────────────────────────────────────────────────────────────────────
app.get('/', (req,res)=>{
  const db=loadDB(); const tools=checkTools();
  const tiktokOk=!!(db.tiktokToken||process.env.TIKTOK_ACCESS_TOKEN);
  const pending=(db.queue||[]).filter(c=>c.status==='queued').length;
  res.send(`<!DOCTYPE html><html><head><title>Social Agent</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>*{box-sizing:border-box}body{font-family:monospace;background:#060a1a;color:#ccc;padding:20px;max-width:820px;margin:0 auto;font-size:13px}
  h1{color:#cc44ff;font-size:20px;margin-bottom:2px}h2{color:#555;font-size:10px;letter-spacing:2px;margin:14px 0 8px;text-transform:uppercase}
  .card{background:#0d1225;border:1px solid rgba(200,68,255,0.18);padding:14px;margin:8px 0;border-radius:4px}
  .stats{display:flex;flex-wrap:wrap;gap:14px;font-size:12px}.stat b{color:#cc44ff}
  input{background:#060a1a;border:1px solid #cc44ff44;color:#fff;padding:9px 11px;width:100%;margin:4px 0;font-family:monospace;border-radius:3px;font-size:12px}
  .row{display:flex;gap:8px}.row input{flex:1}
  .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  button{background:rgba(200,68,255,0.1);border:1px solid #cc44ff;color:#cc44ff;padding:8px 16px;cursor:pointer;font-family:monospace;border-radius:3px;font-size:11px}
  button:hover{background:rgba(200,68,255,0.22)}
  .g{background:rgba(0,255,136,0.08);border-color:#00ff88;color:#00ff88}.g:hover{background:rgba(0,255,136,0.18)}
  .b{background:rgba(0,180,255,0.08);border-color:#00b4ff;color:#00b4ff}.b:hover{background:rgba(0,180,255,0.18)}
  .ok{color:#00ff88}.warn{color:#ffa500}.err{color:#ff4444}
  .log{max-height:200px;overflow-y:auto;font-size:10px;color:#444;line-height:1.7}
  .item{padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px}
  .tag{display:inline-block;padding:1px 6px;border-radius:2px;font-size:9px;margin-right:4px}
  .t-posted{background:rgba(0,255,136,0.1);color:#00ff88}.t-queued{background:rgba(255,200,0,0.1);color:#ffc800}
  .t-ready{background:rgba(0,180,255,0.1);color:#00b4ff}.t-failed{background:rgba(255,60,60,0.1);color:#ff6060}
  .dz{border:2px dashed #cc44ff33;border-radius:4px;padding:20px;text-align:center;cursor:pointer;color:#444;font-size:12px;margin:8px 0;transition:all .2s}
  .dz:hover,.dz.drag{border-color:#cc44ff;color:#cc44ff;background:rgba(200,68,255,0.05)}
  #msg{font-size:11px;margin-top:8px;min-height:16px}
  a{color:#cc44ff}</style></head><body>
  <h1>🤖 SOCIAL AGENT</h1>
  <p style="color:#444;font-size:10px;margin-bottom:10px">Auto-posts Kick + TikTok clips every 2 hours</p>
  <div class="card">
    <div class="stats">
      <span class="stat">📊 Today: <b>${db.stats.today}</b></span>
      <span class="stat">✅ Total: <b>${db.stats.totalPosted}</b></span>
      <span class="stat">⏳ Queue: <b>${pending}</b></span>
      <span class="stat">⏱ Last: <b>${db.lastRun?db.lastRun.slice(11,19):'never'}</b></span>
      <span class="stat">TikTok: <b class="${tiktokOk?'ok':'warn'}">${tiktokOk?'✓ Connected':'<a href="/tiktok/connect">Connect →</a>'}</b></span>
    </div>
    <div style="font-size:10px;color:#444;margin-top:6px">
      yt-dlp: <span class="${tools.ytdlp==='not found'?'err':'ok'}">${tools.ytdlp}</span> &nbsp;|&nbsp;
      ffmpeg: <span class="${tools.ffmpeg==='not found'?'err':'ok'}">${tools.ffmpeg==='not found'?'not found':'✓'}</span> &nbsp;|&nbsp;
      proxy: <span class="${tools.proxy==='not set'?'warn':'ok'}">${tools.proxy}</span>
    </div>
  </div>
  <div class="card">
    <h2>🤖 Automatic Mode</h2>
    <p style="color:#555;font-size:10px;margin-bottom:8px">Searches Kick (top streamers) + TikTok for clips every 2 hours via residential proxy. Fully hands-free.</p>
    <div class="btns">
      <button class="g" onclick="runFull()">▶ Run Now</button>
      <button class="b" onclick="discoverOnly()">🔍 Discover Only</button>
    </div>
    <div id="msg"></div>
  </div>
  <div class="card">
    <h2>📁 Upload Manually</h2>
    <p style="color:#555;font-size:10px;margin-bottom:6px">Download a clip from Kick/TikTok on your Mac → drop it here.</p>
    <div class="dz" id="dz" onclick="document.getElementById('fi').click()">Drop MP4 here or click to browse · Max 200MB</div>
    <input type="file" id="fi" accept="video/*" style="display:none" onchange="handleFile(this.files[0])"/>
    <div class="row"><input id="ut" placeholder="Title"/><input id="us" placeholder="Streamer" style="max-width:180px"/></div>
    <div class="btns"><button class="g" id="upBtn" onclick="doUpload()" disabled>📤 Upload & Post</button></div>
  </div>
  <div class="card">
    <h2>🔗 Add by URL</h2>
    <input id="cu" placeholder="https://kick.com/xqc/clips/... or https://tiktok.com/@.../video/..."/>
    <div class="row" style="margin-top:4px"><input id="ct" placeholder="Title"/><input id="cs" placeholder="Streamer" style="max-width:180px"/></div>
    <div class="btns"><button onclick="addUrl()">➕ Add to Queue</button></div>
  </div>
  <div class="card">
    <h2>Queue (${pending} pending)</h2>
    ${(db.queue||[]).slice(0,8).map(c=>`<div class="item"><span class="tag t-${c.status==='queued'?'queued':c.status==='posted'?'posted':c.status==='ready'?'ready':'failed'}">${c.status}</span>${c.auto?'<span style="font-size:9px;color:#cc44ff;margin-right:4px">AUTO</span>':''}<b style="color:#cc44ff">@${c.streamerName||c.streamer||'?'}</b> — ${(c.title||'').slice(0,55)}</div>`).join('')||'<div style="color:#333;padding:6px 0;font-size:11px">Nothing queued — click Run Now</div>'}
  </div>
  <div class="card">
    <h2>Recent Posts</h2>
    ${db.posted.slice(0,5).map(p=>`<div class="item"><span class="tag t-${p.success?'posted':'ready'}">${p.success?'posted':'saved'}</span><b style="color:#cc44ff">@${p.streamerName||p.streamer||'?'}</b> — ${(p.title||'').slice(0,50)}${p.caption?`<div style="color:#555;font-size:10px;margin-top:1px">${p.caption.slice(0,80)}</div>`:''}</div>`).join('')||'<div style="color:#333;padding:6px 0;font-size:11px">No posts yet</div>'}
  </div>
  <div class="card"><h2>Log</h2><div class="log">${(db.log||[]).map(l=>`<div>${l}</div>`).join('')||'<span style="color:#333">No activity</span>'}</div></div>
  <script>
  let selFile=null;
  const dz=document.getElementById('dz');
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag');});
  dz.addEventListener('dragleave',()=>dz.classList.remove('drag'));
  dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('drag');if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});
  function handleFile(f){selFile=f;dz.textContent='✓ '+f.name+' ('+Math.round(f.size/1024/1024*10)/10+'MB)';document.getElementById('upBtn').disabled=false;if(!document.getElementById('ut').value)document.getElementById('ut').value=f.name.replace(/\.[^.]+$/,'');}
  async function doUpload(){
    if(!selFile)return;const btn=document.getElementById('upBtn');btn.disabled=true;btn.textContent='Uploading...';
    document.getElementById('msg').innerHTML='Uploading...';
    const fd=new FormData();fd.append('video',selFile);fd.append('title',document.getElementById('ut').value||selFile.name);fd.append('streamer',document.getElementById('us').value||'Unknown');
    try{const r=await fetch('/upload',{method:'POST',body:fd});const d=await r.json();
    if(d.success){document.getElementById('msg').innerHTML='<span class="ok">✓ Uploaded! Running agent...</span>';fetch('/run-now',{method:'POST'});setTimeout(()=>location.reload(),5000);}
    else{document.getElementById('msg').innerHTML='<span class="err">'+d.error+'</span>';btn.disabled=false;btn.textContent='📤 Upload & Post';}}
    catch(e){document.getElementById('msg').innerHTML='<span class="err">'+e.message+'</span>';btn.disabled=false;btn.textContent='📤 Upload & Post';}
  }
  async function addUrl(){
    const url=document.getElementById('cu').value.trim();if(!url)return;
    const r=await fetch('/add-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,title:document.getElementById('ct').value||'Clip',streamer:document.getElementById('cs').value||'Unknown'})});
    const d=await r.json();document.getElementById('msg').innerHTML=d.success?'<span class="ok">✓ Added</span>':'<span class="err">'+d.error+'</span>';
    if(d.success){document.getElementById('cu').value='';setTimeout(()=>location.reload(),2000);}
  }
  async function runFull(){document.getElementById('msg').innerHTML='<span class="ok">▶ Running...</span>';await fetch('/full-run',{method:'POST'});setTimeout(()=>location.reload(),15000);}
  async function discoverOnly(){document.getElementById('msg').innerHTML='<span class="ok">🔍 Discovering...</span>';await fetch('/discover',{method:'POST'});setTimeout(()=>location.reload(),10000);}
  setTimeout(()=>location.reload(),25000);
  </script></body></html>`);
});

app.get('/status',(req,res)=>{const db=loadDB();res.json({status:'running',tools:checkTools(),stats:db.stats,lastRun:db.lastRun,pending:(db.queue||[]).filter(c=>c.status==='queued').length,log:(db.log||[]).slice(0,10)});});
app.post('/full-run',(req,res)=>{res.json({message:'started'});fullRun().catch(e=>addLog('[Error] '+e.message));});
app.post('/discover',(req,res)=>{res.json({message:'started'});autoDiscover().catch(e=>addLog('[Error] '+e.message));});
app.post('/run-now',(req,res)=>{res.json({message:'started'});processQueue().catch(e=>addLog('[Error] '+e.message));});
app.post('/upload',upload.single('video'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'No file'});
  const db=loadDB();db.queue=db.queue||[];
  db.queue.unshift({id:'up_'+Date.now(),title:req.body.title||req.file.originalname||'Clip',streamerName:req.body.streamer||'Unknown',streamer:req.body.streamer||'Unknown',localPath:req.file.path,status:'queued',addedAt:new Date().toISOString()});
  if(db.queue.length>50)db.queue=db.queue.slice(0,50);saveDB(db);addLog(`[Upload] ${req.file.originalname}`);res.json({success:true});
});
app.post('/add-url',(req,res)=>{
  const{url,title,streamer}=req.body;if(!url)return res.status(400).json({error:'URL required'});
  const db=loadDB();db.queue=db.queue||[];
  db.queue.unshift({id:'url_'+Date.now(),url,title:title||'Clip',streamerName:streamer||'Unknown',streamer:streamer||'Unknown',status:'queued',addedAt:new Date().toISOString()});
  if(db.queue.length>50)db.queue=db.queue.slice(0,50);saveDB(db);addLog(`[URL] ${url.slice(0,55)}`);res.json({success:true});
});
app.get('/posted',(req,res)=>res.json(loadDB().posted.slice(0,20)));
app.get('/queue',(req,res)=>res.json((loadDB().queue||[]).slice(0,20)));
app.post('/tiktok-token',(req,res)=>{const db=loadDB();db.tiktokToken=req.body.access_token;if(req.body.refresh_token)db.tiktokRefresh=req.body.refresh_token;saveDB(db);addLog('[TikTok] Token saved');res.json({success:true});});
app.get('/tiktok/connect',(req,res)=>{const ru=encodeURIComponent(process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`);res.redirect(`https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish&response_type=code&redirect_uri=${ru}&state=agentnet`);});
app.get('/tiktok/callback',async(req,res)=>{
  const{code}=req.query;if(!code)return res.status(400).send('No code');
  try{const t=await axios.post('https://open.tiktokapis.com/v2/oauth/token/',{client_key:process.env.TIKTOK_CLIENT_KEY,client_secret:process.env.TIKTOK_CLIENT_SECRET,code,grant_type:'authorization_code',redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`});
  const db=loadDB();db.tiktokToken=t.data.access_token;db.tiktokRefresh=t.data.refresh_token;saveDB(db);addLog('[TikTok] ✓ Connected');
  res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! Close this tab.</h2>');}
  catch(e){res.status(500).send('Error: '+e.message);}
});

const PORT=process.env.PORT||3002;
app.listen(PORT,()=>{
  addLog(`Social Agent on port ${PORT}`);
  const t=checkTools();addLog(`Tools: yt-dlp=${t.ytdlp} proxy=${t.proxy}`);
  setTimeout(()=>fullRun().catch(e=>addLog('[Startup] '+e.message)),10000);
});
cron.schedule('0 */2 * * *',()=>{addLog('[Cron] Scheduled run');fullRun().catch(e=>addLog('[Cron] '+e.message));});
