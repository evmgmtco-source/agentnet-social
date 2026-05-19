# AgentNet — Social Agent (TikTok Clip Bot)

Automatically finds top Kick clips and posts them to TikTok every 2 hours.

## Setup

### 1. TikTok Developer Account
1. Go to developers.tiktok.com → Manage Apps → Connect an app
2. Add products: Content Posting API + Login Kit
3. Copy Client Key + Client Secret
4. Set redirect URI to: https://YOUR_RAILWAY_URL/tiktok/callback
5. Submit for review (2-7 days)

### 2. Deploy to Railway
1. Push this folder to a GitHub repo
2. New project on railway.app → Deploy from GitHub
3. Add environment variables (see .env.example)
4. Deploy

### 3. Connect TikTok Account
Once deployed, visit: https://YOUR_RAILWAY_URL/tiktok/connect
This opens TikTok OAuth — log in with the account you want to post to.

## API Endpoints
GET  /status          → agent stats, recent posts, queue
GET  /posted          → last 20 posted clips
POST /run-now         → trigger a run immediately
GET  /tiktok/connect  → start TikTok OAuth flow
GET  /tiktok/callback → OAuth callback (set this as redirect URI in TikTok dev)
