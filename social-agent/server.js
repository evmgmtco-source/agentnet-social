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
  catch { return { posted:[], queue:[], stats:{totalPosted:0,today:0,lastReset:new Date().toDateString()}, streamers:[], lastRun:null }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2)); }
function checkDailyReset() {
  const db=loadDB();
  if(db.stats.lastReset!==new Date().toDateString()){db.stats.today=0;db.stats.lastReset=new Date().toDateString();saveDB(db);}
}

// ── TOP KICK STREAMERS — hardcoded with rotation ──────────────────────────────
// Kick blocks server APIs. We use a curated list of top streamers
// and use yt-dlp to pull their actual clips directly.
const TOP_STREAMERS = [
  { slug:'xqc',           name:'xQc'         },
  { slug:'adinross',      name:'AdinRoss'     },
  { slug:'trainwreckstv', name:'Trainwreck'   },
  { slug:'kaicenat',      name:'KaiCenat'     },
  { slug:'speed',         name:'IShowSpeed'   },
  { slug:'n3on',          name:'N3on'         },
  { slug:'jynxzi',        name:'Jynxzi'       },
  { slug:'nickmercs',     name:'Nickmercs'    },
];

function getTopStreamers() {
  // Rotate through list to get variety — pick 5 each run
  const db = loadDB();
  const offset = (db.posted.length || 0) % TOP_STREAMERS.length;
  const rotated = [...TOP_STREAMERS.slice(offset), ...TOP_STREAMERS.slice(0, offset)];
  return rotated.slice(0, 5);
}

// ── GET CLIPS VIA YT-DLP ──────────────────────────────────────────────────────
function getClipsViaYtDlp(slug, name) {
  return new Promise((resolve) => {
    // yt-dlp can list clips from Kick channels
    const cmd = `yt-dlp --flat-playlist --dump-json --playlist-end 5 "https://kick.com/${slug}/clips" 2>/dev/null`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      try {
        const clips = stdout.trim().split('\n')
          .filter(l => l.trim())
          .map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean)
          .map(c => ({
            id: c.id || c.display_id,
            title: c.title || `${name} clip`,
            url: c.webpage_url || `https://kick.com/${slug}/clips/${c.id}`,
            views: c.view_count || 0,
            duration: c.duration || 30,
            streamerName: name,
            channel: slug,
          }))
          .filter(c => c.id && (c.duration || 30) <= 65);
        resolve(clips);
      } catch(e) { resolve([]); }
    });
  });
}

// ── DOWNLOAD CLIP ─────────────────────────────────────────────────────────────
function downloadClip(clipUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `yt-dlp -f "best[ext=mp4][filesize<50M]/best[filesize<50M]/best" -o "${outputPath}" "${clipUrl}" --no-playlist -q --socket-timeout 30`;
    exec(cmd, { timeout: 60000 }, (err) => {
      if (err) { reject(new Error('yt-dlp download failed: ' + err.message)); return; }
      if (!fs.existsSync(outputPath)) { reject(new Error('File not created')); return; }
      resolve();
    });
  });
}

// ── CAPTION GENERATOR ─────────────────────────────────────────────────────────
async function generateCaption(clip) {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: 'You write viral TikTok captions for gaming/streaming clips. Be punchy, use emojis. Max 100 chars for caption.',
      messages: [{ role:'user', content:`TikTok caption for: "${clip.title}" by @${clip.streamerName} on Kick\nFormat:\nCAPTION: [punchy text + emojis]\nHASHTAGS: #${clip.streamerName.toLowerCase()} #kick #gaming #fyp #viral` }]
    });
    const text = msg.content[0].text;
    const cap  = (text.match(/CAPTION:\s*(.+)/)||[])[1]  || `🔥 ${clip.title}`;
    const tags = (text.match(/HASHTAGS:\s*(.+)/)||[])[1] || `#${clip.streamerName.toLowerCase()} #kick #gaming #fyp`;
    return { caption: cap.trim() + ` (📺 @${clip.streamerName} on Kick)`, hashtags: tags.trim() };
  } catch(e) {
    return { caption:`🔥 ${clip.title} (📺 @${clip.streamerName} on Kick)`, hashtags:`#${clip.streamerName.toLowerCase()} #kick #gaming #fyp #viral` };
  }
}

// ── TIKTOK POST ───────────────────────────────────────────────────────────────
async function postToTikTok(videoPath, caption, hashtags) {
  const db = loadDB();
  const token = db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!token || token.length < 10) {
    console.log('[TikTok] No token — clip saved to queue for manual post');
    return { success:false, reason:'no_token' };
  }
  try {
    const videoBuffer = fs.readFileSync(videoPath);
    const init = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      { post_info:{ title:`${caption} ${hashtags}`.slice(0,150), privacy_level:'PUBLIC_TO_EVERYONE', disable_duet:false, disable_comment:false, disable_stitch:false }, source_info:{ source:'FILE_UPLOAD', video_size:videoBuffer.length } },
      { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
    );
    await axios.put(init.data.data.upload_url, videoBuffer, {
      headers:{ 'Content-Type':'video/mp4', 'Content-Range':`bytes 0-${videoBuffer.length-1}/${videoBuffer.length}` }
    });
    console.log('[TikTok] ✓ Posted');
    return { success:true };
  } catch(e) {
    console.error('[TikTok] Failed:', e.response?.data?.error?.message || e.message);
    return { success:false, reason:e.message };
  }
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────
async function runAgent() {
  console.log('\n[Social Agent] Starting:', new Date().toISOString());
  checkDailyReset();
  const db = loadDB();

  const streamers = getTopStreamers();
  db.streamers = streamers; saveDB(db);
  console.log('[Social Agent] Checking streamers:', streamers.map(s=>s.name).join(', '));

  // Get clips via yt-dlp
  let allClips = [];
  for (const s of streamers) {
    console.log(`[Kick] Fetching clips for ${s.name}...`);
    const clips = await getClipsViaYtDlp(s.slug, s.name);
    console.log(`[Kick] ${s.name}: ${clips.length} clips`);
    allClips.push(...clips);
    await new Promise(r => setTimeout(r, 2000));
  }

  const postedIds = db.posted.map(p => p.clipId);
  const newClips = allClips
    .filter(c => c.id && !postedIds.includes(c.id))
    .sort((a,b) => b.views - a.views)
    .slice(0, 3);

  console.log(`[Social Agent] ${allClips.length} total, ${newClips.length} new to post`);

  for (const clip of newClips) {
    try {
      console.log(`[Social Agent] Processing: "${clip.title}" by ${clip.streamerName}`);
      const { caption, hashtags } = await generateCaption(clip);

      // Add to queue
      db.queue.unshift({ clipId:clip.id, title:clip.title, streamer:clip.streamerName, caption, hashtags, status:'downloading', addedAt:new Date().toISOString() });
      if (db.queue.length > 30) db.queue = db.queue.slice(0,30);
      saveDB(db);

      // Download
      const dir = './videos';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      const videoPath = path.join(dir, `${clip.id}.mp4`);
      await downloadClip(clip.url, videoPath);
      console.log(`[Social Agent] Downloaded: ${videoPath}`);

      // Post
      const result = await postToTikTok(videoPath, caption, hashtags);

      // Update records
      const qi = db.queue.find(q => q.clipId === clip.id);
      if (qi) qi.status = result.success ? 'posted' : 'ready_to_post';
      db.posted.unshift({ clipId:clip.id, title:clip.title, streamer:clip.streamerName, caption, hashtags, postedAt:new Date().toISOString(), success:result.success });
      if (db.posted.length > 100) db.posted = db.posted.slice(0,100);
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      saveDB(db);

      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      await new Promise(r => setTimeout(r, 20000)); // Space out posts
    } catch(e) {
      console.error('[Social Agent] Error on clip:', e.message);
    }
  }

  db.lastRun = new Date().toISOString(); saveDB(db);
  console.log('[Social Agent] Complete. Posted today:', db.stats.today);
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get('/status', (req,res) => {
  const db = loadDB();
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
  const ru = encodeURIComponent(process.env.TIKTOK_REDIRECT_URI || `${process.env.SERVER_URL}/tiktok/callback`);
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish&response_type=code&redirect_uri=${ru}&state=agentnet`);
});
app.get('/tiktok/callback', async (req,res) => {
  const { code } = req.query; if (!code) return res.status(400).send('No code');
  try {
    const t = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key:process.env.TIKTOK_CLIENT_KEY, client_secret:process.env.TIKTOK_CLIENT_SECRET,
      code, grant_type:'authorization_code',
      redirect_uri:process.env.TIKTOK_REDIRECT_URI||`${process.env.SERVER_URL}/tiktok/callback`
    });
    const db=loadDB(); db.tiktokToken=t.data.access_token; db.tiktokRefresh=t.data.refresh_token; saveDB(db);
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px;margin:0">✓ TikTok connected! Close this tab.</h2>');
  } catch(e) { res.status(500).send('OAuth error: '+e.message); }
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Social Agent on port ${PORT}`);
  setTimeout(() => runAgent().catch(console.error), 8000);
});
cron.schedule('0 */2 * * *', () => runAgent().catch(console.error));
