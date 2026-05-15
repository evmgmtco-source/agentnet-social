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
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { posted:[], queue:[], stats:{ totalPosted:0, today:0, lastReset:new Date().toDateString() }, streamers:[], lastRun:null }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function checkDailyReset() {
  const db=loadDB();
  if(db.stats.lastReset!==new Date().toDateString()){db.stats.today=0;db.stats.lastReset=new Date().toDateString();saveDB(db);}
}

// ── KICK API — with proper headers to avoid 403 ───────────────────────────────
const KICK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://kick.com/',
  'Origin': 'https://kick.com',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

async function getTopKickStreamers() {
  // Try multiple Kick API endpoints
  const endpoints = [
    'https://kick.com/api/v2/channels/featured',
    'https://kick.com/api/v1/featured-livestreams',
    'https://kick.com/api/v2/livestreams?limit=20&sort=viewers',
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { headers: KICK_HEADERS, timeout: 10000 });
      const data = res.data;
      const list = data.data || data || [];
      if (list.length > 0) {
        const streamers = list
          .sort((a,b) => (b.viewer_count||b.viewers||0)-(a.viewer_count||a.viewers||0))
          .slice(0,5)
          .map(s => ({
            slug: s.slug || s.channel?.slug || s.broadcaster_username,
            name: s.channel?.user?.username || s.broadcaster_username || s.slug,
            viewers: s.viewer_count || s.viewers || 0
          }))
          .filter(s => s.slug);
        if (streamers.length > 0) {
          console.log('[Kick] Found streamers:', streamers.map(s=>s.name));
          return streamers;
        }
      }
    } catch(e) {
      console.log(`[Kick] ${url} failed: ${e.message}`);
    }
  }

  // Hardcoded fallback — always works
  console.log('[Kick] Using hardcoded top streamers');
  return [
    { slug:'xqc',           name:'xQc',        viewers:0 },
    { slug:'adinross',      name:'AdinRoss',    viewers:0 },
    { slug:'trainwreckstv', name:'Trainwreck',  viewers:0 },
    { slug:'kaicenat',      name:'KaiCenat',    viewers:0 },
    { slug:'speed',         name:'IShowSpeed',  viewers:0 },
  ];
}

async function getStreamerClips(slug, name) {
  const endpoints = [
    `https://kick.com/api/v2/clips?channel=${slug}&limit=10&sort=view_count`,
    `https://kick.com/api/v2/channels/${slug}/clips?limit=10&sort=view_count`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { headers: KICK_HEADERS, timeout: 10000 });
      const clips = res.data.data || res.data || [];
      return clips
        .filter(c => c.clip_share_enabled !== false && (c.video_url || c.clip_url))
        .filter(c => (c.duration || 30) <= 60)
        .map(c => ({
          id: c.id || c.clip_id,
          title: c.title || `${name} clip`,
          url: c.video_url || c.clip_url,
          views: c.view_count || 0,
          duration: c.duration || 30,
          streamerName: name,
          channel: slug,
        }));
    } catch(e) {
      console.log(`[Kick] clips for ${slug} failed: ${e.message}`);
    }
  }
  return [];
}

// ── CAPTION GENERATOR ─────────────────────────────────────────────────────────
async function generateCaption(clip) {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: 'You write viral TikTok captions for gaming clips. Be punchy, use emojis, max 100 chars for caption. Always credit the streamer.',
      messages:[{role:'user', content:`Write TikTok caption for: "${clip.title}" by ${clip.streamerName} on Kick.\nFormat:\nCAPTION: [text with emojis]\nHASHTAGS: #${clip.streamerName} #kick #gaming #fyp #viral #clips`}]
    });
    const text = msg.content[0].text;
    const cap = (text.match(/CAPTION:\s*(.+)/)||[])[1] || clip.title;
    const tags = (text.match(/HASHTAGS:\s*(.+)/)||[])[1] || `#${clip.streamerName} #kick #gaming #fyp`;
    return { caption: cap.trim(), hashtags: tags.trim() };
  } catch(e) {
    return { caption: `🔥 ${clip.title} (via @${clip.streamerName} on Kick)`, hashtags: `#${clip.streamerName} #kick #gaming #fyp #viral` };
  }
}

// ── VIDEO DOWNLOAD ────────────────────────────────────────────────────────────
async function downloadClip(url, outputPath) {
  return new Promise((resolve, reject) => {
    // Try yt-dlp first
    exec(`yt-dlp -f "best[ext=mp4]/best" -o "${outputPath}" "${url}" --no-playlist -q`, (err) => {
      if (!err && fs.existsSync(outputPath)) { resolve(); return; }
      // Fallback: direct download
      axios({ url, responseType:'stream', headers: KICK_HEADERS, timeout:30000 })
        .then(res => {
          const w = fs.createWriteStream(outputPath);
          res.data.pipe(w);
          w.on('finish', resolve);
          w.on('error', reject);
        }).catch(reject);
    });
  });
}

// ── TIKTOK POST ───────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db = loadDB();
  const token = db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!token || token === 'your_token_here') {
    console.log('[TikTok] No valid token — queued for manual post');
    return { success:false, reason:'no_token' };
  }
  try {
    const videoBuffer = fs.readFileSync(videoPath);
    const initRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/',
      { post_info:{ title:`${caption} ${hashtags}`.slice(0,150), privacy_level:'PUBLIC_TO_EVERYONE', disable_duet:false, disable_comment:false, disable_stitch:false }, source_info:{ source:'FILE_UPLOAD', video_size:videoBuffer.length } },
      { headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    const { upload_url } = initRes.data.data;
    await axios.put(upload_url, videoBuffer, { headers:{ 'Content-Type':'video/mp4', 'Content-Range':`bytes 0-${videoBuffer.length-1}/${videoBuffer.length}` } });
    console.log('[TikTok] Posted successfully');
    return { success:true };
  } catch(e) {
    console.error('[TikTok] Post failed:', e.response?.data?.error?.message || e.message);
    return { success:false, reason:e.message };
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function runAgent() {
  console.log('\n[Social Agent] Run starting:', new Date().toISOString());
  checkDailyReset();
  const db = loadDB();

  const streamers = await getTopKickStreamers();
  db.streamers = streamers; saveDB(db);

  let allClips = [];
  for (const s of streamers) {
    const clips = await getStreamerClips(s.slug, s.name);
    allClips.push(...clips);
    await new Promise(r=>setTimeout(r,1000)); // rate limit
  }

  const postedIds = db.posted.map(p=>p.clipId);
  const newClips = allClips.filter(c=>!postedIds.includes(c.id)).sort((a,b)=>b.views-a.views).slice(0,3);
  console.log(`[Social Agent] ${allClips.length} clips found, ${newClips.length} new`);

  for (const clip of newClips) {
    try {
      const { caption, hashtags } = await generateCaption(clip);
      db.queue.unshift({ clipId:clip.id, title:clip.title, streamer:clip.streamerName, caption, hashtags, status:'queued', addedAt:new Date().toISOString() });
      if(db.queue.length>20)db.queue=db.queue.slice(0,20);
      saveDB(db);

      const videoDir='./videos';
      if(!fs.existsSync(videoDir))fs.mkdirSync(videoDir);
      const videoPath=path.join(videoDir,`${clip.id}.mp4`);
      await downloadClip(clip.url, videoPath);

      const result = await postToTikTok(videoPath, caption, hashtags);

      const qi = db.queue.find(q=>q.clipId===clip.id);
      if(qi) qi.status = result.success?'posted':'ready_to_post';
      db.posted.unshift({ clipId:clip.id, title:clip.title, streamer:clip.streamerName, caption, hashtags, postedAt:new Date().toISOString(), success:result.success });
      if(db.posted.length>100)db.posted=db.posted.slice(0,100);
      if(result.success){db.stats.totalPosted++;db.stats.today++;}
      saveDB(db);

      if(fs.existsSync(videoPath))fs.unlinkSync(videoPath);
      await new Promise(r=>setTimeout(r,15000));
    } catch(e) {
      console.error('[Social Agent] Error:', e.message);
    }
  }

  db.lastRun = new Date().toISOString(); saveDB(db);
  console.log('[Social Agent] Done. Posted today:', db.stats.today);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/status', (req,res) => {
  const db=loadDB();
  res.json({ status:'running', streamers:db.streamers, stats:db.stats, lastRun:db.lastRun, recentPosts:db.posted.slice(0,5), queue:db.queue.slice(0,5) });
});
app.get('/posted', (req,res) => res.json(loadDB().posted.slice(0,20)));
app.get('/queue',  (req,res) => res.json(loadDB().queue.slice(0,20)));
app.post('/run-now', (req,res) => { res.json({message:'started'}); runAgent().catch(console.error); });
app.post('/tiktok-token', (req,res) => {
  const db=loadDB(); db.tiktokToken=req.body.access_token; if(req.body.refresh_token)db.tiktokRefresh=req.body.refresh_token; saveDB(db);
  res.json({success:true});
});
app.get('/tiktok/connect', (req,res) => {
  const scope='user.info.basic,video.upload,video.publish';
  const ru=encodeURIComponent(process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`);
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=${scope}&response_type=code&redirect_uri=${ru}&state=agentnet`);
});
app.get('/tiktok/callback', async (req,res) => {
  const {code}=req.query; if(!code) return res.status(400).send('No code');
  try {
    const t=await axios.post('https://open.tiktokapis.com/v2/oauth/token/',{
      client_key:process.env.TIKTOK_CLIENT_KEY, client_secret:process.env.TIKTOK_CLIENT_SECRET,
      code, grant_type:'authorization_code',
      redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`
    });
    const db=loadDB(); db.tiktokToken=t.data.access_token; db.tiktokRefresh=t.data.refresh_token; saveDB(db);
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! You can close this tab.</h2>');
  } catch(e){ res.status(500).send('OAuth error: '+e.message); }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Social Agent running on port ${PORT}`);
  console.log(`Status: ${process.env.SERVER_URL||'http://localhost:'+PORT}/status`);
  setTimeout(()=>runAgent().catch(console.error), 5000);
});

// Run every 2 hours
cron.schedule('0 */2 * * *', ()=>{ console.log('[Cron] Running agent'); runAgent().catch(console.error); });
