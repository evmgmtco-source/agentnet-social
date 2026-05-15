require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── STATE ─────────────────────────────────────────────────────────────────────
const DB_FILE = './social_state.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { posted: [], queue: [], stats: { totalPosted: 0, today: 0, lastReset: new Date().toDateString() }, streamers: [], lastRun: null }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Reset daily count
function checkDailyReset() {
  const db = loadDB();
  if (db.stats.lastReset !== new Date().toDateString()) {
    db.stats.today = 0;
    db.stats.lastReset = new Date().toDateString();
    saveDB(db);
  }
}

// ── KICK API ──────────────────────────────────────────────────────────────────
async function getTopKickStreamers() {
  try {
    // Get featured/top streamers by viewer count
    const res = await axios.get('https://kick.com/api/v2/livestreams', {
      params: { limit: 20, sort: 'viewers' },
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    const streamers = (res.data.data || res.data || [])
      .sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0))
      .slice(0, 5)
      .map(s => ({ slug: s.slug || s.channel?.slug, name: s.channel?.user?.username || s.slug, viewers: s.viewer_count || 0 }))
      .filter(s => s.slug);
    console.log(`[Kick] Found top streamers:`, streamers.map(s => s.name));
    return streamers;
  } catch (e) {
    console.error('[Kick] Error fetching streamers:', e.message);
    // Fallback to known popular streamers
    return [
      { slug: 'xqc', name: 'xQc', viewers: 0 },
      { slug: 'adinross', name: 'AdinRoss', viewers: 0 },
      { slug: 'trainwreckstv', name: 'Trainwreck', viewers: 0 },
      { slug: 'kaicenat', name: 'KaiCenat', viewers: 0 },
      { slug: 'speed', name: 'IShowSpeed', viewers: 0 },
    ];
  }
}

async function getStreamerClips(slug) {
  try {
    const res = await axios.get(`https://kick.com/api/v2/clips`, {
      params: { channel: slug, limit: 10, sort: 'view_count' },
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    const clips = (res.data.data || res.data || []);
    // Filter clips that allow sharing (clip_share_enabled or no explicit restriction)
    return clips
      .filter(c => c.clip_share_enabled !== false && c.video_url)
      .map(c => ({
        id: c.id,
        title: c.title || 'Clip',
        url: c.video_url || c.clip_url,
        thumbnail: c.thumbnail_url,
        views: c.view_count || 0,
        duration: c.duration || 30,
        channel: c.channel?.slug || slug,
        channelName: c.channel?.user?.username || slug,
      }))
      .filter(c => c.duration <= 60); // TikTok max 60s for standard posts
  } catch (e) {
    console.error(`[Kick] Error fetching clips for ${slug}:`, e.message);
    return [];
  }
}

// ── CLAUDE CAPTION GENERATOR ──────────────────────────────────────────────────
async function generateCaption(clip, streamerName) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: `You are a viral TikTok content creator specialising in gaming/streaming clips. Write short, punchy TikTok captions that maximise engagement. Use relevant hashtags. Keep it under 150 chars for the caption, then add hashtags separately.`,
    messages: [{
      role: 'user',
      content: `Write a TikTok caption for this Kick clip:
Title: "${clip.title}"
Streamer: @${streamerName}
Views on Kick: ${clip.views}

Format your response as:
CAPTION: [caption text — punchy, emoji, no hashtags]
HASHTAGS: [space-separated hashtags, include #${streamerName} #kick #gaming #fyp #viral]`
    }]
  });

  const text = msg.content[0].text;
  const captionMatch = text.match(/CAPTION:\s*(.+)/);
  const hashtagsMatch = text.match(/HASHTAGS:\s*(.+)/);

  return {
    caption: (captionMatch ? captionMatch[1].trim() : clip.title) + ` (via @${streamerName} on Kick)`,
    hashtags: hashtagsMatch ? hashtagsMatch[1].trim() : `#${streamerName} #kick #gaming #fyp #viral`,
  };
}

// ── TIKTOK API ────────────────────────────────────────────────────────────────
async function refreshTikTokToken() {
  if (!process.env.TIKTOK_REFRESH_TOKEN) return null;
  try {
    const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: process.env.TIKTOK_REFRESH_TOKEN,
    });
    const { access_token, refresh_token } = res.data;
    // Update env/DB with new tokens
    const db = loadDB();
    db.tiktokToken = access_token;
    db.tiktokRefresh = refresh_token;
    saveDB(db);
    return access_token;
  } catch (e) {
    console.error('[TikTok] Token refresh failed:', e.message);
    return null;
  }
}

async function postToTikTok(videoPath, caption, hashtags) {
  const db = loadDB();
  const token = db.tiktokToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) { console.log('[TikTok] No access token — skipping post'); return { success: false, reason: 'no_token' }; }

  try {
    // Step 1: Init upload
    const initRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: `${caption} ${hashtags}`.slice(0, 150),
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: { source: 'FILE_UPLOAD', video_size: fs.statSync(videoPath).size }
      },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const { publish_id, upload_url } = initRes.data.data;

    // Step 2: Upload video
    const videoBuffer = fs.readFileSync(videoPath);
    await axios.put(upload_url, videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      }
    });

    console.log(`[TikTok] Posted successfully. Publish ID: ${publish_id}`);
    return { success: true, publishId: publish_id };
  } catch (e) {
    console.error('[TikTok] Post failed:', e.response?.data || e.message);
    return { success: false, reason: e.message };
  }
}

// ── DOWNLOAD CLIP ─────────────────────────────────────────────────────────────
async function downloadAndProcessClip(clipUrl, outputPath) {
  return new Promise((resolve, reject) => {
    // Use yt-dlp to download
    const tmpPath = outputPath.replace('.mp4', '_raw.mp4');
    const cmd = `yt-dlp -f "best[ext=mp4]/best" -o "${tmpPath}" "${clipUrl}" --no-playlist --quiet`;

    exec(cmd, (err) => {
      if (err) {
        // Fallback: try direct download
        axios({ url: clipUrl, responseType: 'stream' })
          .then(res => {
            const writer = fs.createWriteStream(tmpPath);
            res.data.pipe(writer);
            writer.on('finish', () => processVideo(tmpPath, outputPath, resolve, reject));
            writer.on('error', reject);
          }).catch(reject);
        return;
      }
      processVideo(tmpPath, outputPath, resolve, reject);
    });
  });
}

function processVideo(inputPath, outputPath, resolve, reject) {
  // Convert to TikTok spec: 9:16 ratio, max 60s, h264
  const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -t 60 -y "${outputPath}" 2>/dev/null`;

  exec(ffmpegCmd, (err) => {
    // Cleanup raw file
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (err || !fs.existsSync(outputPath)) {
      // If ffmpeg failed, use original
      if (fs.existsSync(inputPath)) { fs.renameSync(inputPath, outputPath); resolve(); }
      else reject(new Error('Video processing failed'));
      return;
    }
    resolve();
  });
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────
async function runSocialAgent() {
  console.log('\n[Social Agent] Starting run at', new Date().toISOString());
  checkDailyReset();
  const db = loadDB();
  db.lastRun = new Date().toISOString();

  // Get top streamers
  const streamers = await getTopKickStreamers();
  db.streamers = streamers;

  // Get clips from each streamer
  let allClips = [];
  for (const streamer of streamers) {
    const clips = await getStreamerClips(streamer.slug);
    allClips.push(...clips.map(c => ({ ...c, streamerName: streamer.name })));
  }

  // Sort by views, deduplicate (don't repost)
  const posted_ids = db.posted.map(p => p.clipId);
  const newClips = allClips
    .filter(c => !posted_ids.includes(c.id))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3); // Process up to 3 new clips per run

  console.log(`[Social Agent] Found ${allClips.length} total clips, ${newClips.length} new`);

  // Process and post each new clip
  for (const clip of newClips) {
    try {
      console.log(`[Social Agent] Processing: ${clip.title} by ${clip.streamerName}`);

      // Generate caption with Claude
      const { caption, hashtags } = await generateCaption(clip, clip.streamerName);
      console.log(`[Social Agent] Caption: ${caption}`);

      // Add to queue
      db.queue.push({ clipId: clip.id, title: clip.title, streamer: clip.streamerName, caption, hashtags, addedAt: new Date().toISOString(), status: 'queued' });
      saveDB(db);

      // Download
      const videoDir = './videos';
      if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir);
      const videoPath = path.join(videoDir, `${clip.id}.mp4`);
      await downloadAndProcessClip(clip.url, videoPath);

      // Post to TikTok
      const result = await postToTikTok(videoPath, caption, hashtags);

      // Update DB
      const queueItem = db.queue.find(q => q.clipId === clip.id);
      if (queueItem) queueItem.status = result.success ? 'posted' : 'failed';
      db.posted.push({ clipId: clip.id, title: clip.title, streamer: clip.streamerName, postedAt: new Date().toISOString(), publishId: result.publishId, caption, success: result.success });
      if (result.success) { db.stats.totalPosted++; db.stats.today++; }
      if (db.posted.length > 100) db.posted = db.posted.slice(-100);
      saveDB(db);

      // Cleanup video
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

      // Space out posts (don't spam TikTok)
      await new Promise(r => setTimeout(r, 30000));

    } catch (e) {
      console.error(`[Social Agent] Error processing clip ${clip.id}:`, e.message);
    }
  }

  db.lastRun = new Date().toISOString();
  saveDB(db);
  console.log('[Social Agent] Run complete. Posted today:', db.stats.today);
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const db = loadDB();
  res.json({ status: 'running', streamers: db.streamers, stats: db.stats, lastRun: db.lastRun, recentPosts: db.posted.slice(-5), queue: db.queue.slice(-5) });
});

app.get('/posted', (req, res) => {
  const db = loadDB();
  res.json(db.posted.slice(-20));
});

app.post('/run-now', async (req, res) => {
  res.json({ message: 'Agent started' });
  runSocialAgent().catch(console.error);
});

app.post('/tiktok-token', (req, res) => {
  const { access_token, refresh_token } = req.body;
  const db = loadDB();
  db.tiktokToken = access_token;
  if (refresh_token) db.tiktokRefresh = refresh_token;
  saveDB(db);
  res.json({ success: true });
});

// TikTok OAuth callback
app.get('/tiktok/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');
  try {
    const tokenRes = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.TIKTOK_REDIRECT_URI || `${process.env.SERVER_URL}/tiktok/callback`,
    });
    const db = loadDB();
    db.tiktokToken = tokenRes.data.access_token;
    db.tiktokRefresh = tokenRes.data.refresh_token;
    saveDB(db);
    res.send('<h2 style="font-family:monospace;color:#00ff88;background:#060a1a;padding:40px">✓ TikTok connected successfully! You can close this tab.</h2>');
  } catch (e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// TikTok OAuth redirect
app.get('/tiktok/connect', (req, res) => {
  const scope = 'user.info.basic,video.upload,video.publish';
  const redirectUri = encodeURIComponent(process.env.TIKTOK_REDIRECT_URI || `${process.env.SERVER_URL}/tiktok/callback`);
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=${scope}&response_type=code&redirect_uri=${redirectUri}&state=agentnet`;
  res.redirect(url);
});

// ── CRON SCHEDULE ─────────────────────────────────────────────────────────────
// Run every 2 hours
cron.schedule('0 */2 * * *', () => {
  console.log('[Cron] Triggering Social Agent');
  runSocialAgent().catch(console.error);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Social Agent backend running on port ${PORT}`);
  console.log(`TikTok OAuth: ${process.env.SERVER_URL || 'http://localhost:'+PORT}/tiktok/connect`);
  // Run once on startup (after 10s delay)
  setTimeout(() => runSocialAgent().catch(console.error), 10000);
});
