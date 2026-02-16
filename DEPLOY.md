# 🚀 Quick Deployment Guide

Follow these steps to deploy your bot for 24/7 operation with monitoring.

## Prerequisites

- [ ] Bot token from @BotFather
- [ ] Supabase account with database set up
- [ ] GitHub account
- [ ] Your Telegram user ID (get from @userinfobot)

## Step-by-Step Deployment

### 1. Push to GitHub (2 minutes)

```bash
# Initialize git if not already done
git init
git add .
git commit -m "Initial bot setup with monitoring"

# Create GitHub repository and push
# Visit github.com/new to create repository
git remote add origin https://github.com/yourusername/my-helper.git
git push -u origin main
```

### 2. Deploy to Railway (5 minutes)

1. **Sign up:** Visit [railway.app](https://railway.app) and sign in with GitHub

2. **Create project:**
   - Click **New Project**
   - Select **Deploy from GitHub repo**
   - Choose `my-helper` repository

3. **Add environment variables:**

   Go to **Variables** tab and add:

   ```
   TELEGRAM_BOT_TOKEN=your_token_from_botfather
   ADMIN_USER_ID=your_telegram_user_id
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   NODE_ENV=production
   ```

4. **Get your domain:**
   - Go to **Settings** → **Networking**
   - Click **Generate Domain**
   - Copy the domain (e.g., `my-helper-production.up.railway.app`)

5. **Enable webhook mode (optional but recommended):**

   Add two more variables:
   ```
   WEBHOOK_DOMAIN=my-helper-production.up.railway.app
   WEBHOOK_PORT=3000
   ```

6. **Wait for deployment:**
   - Check **Deployments** tab
   - Wait for "✅ Bot is running!" in logs (~2 minutes)

### 3. Test Your Bot (1 minute)

1. Open Telegram and message your bot
2. Try these commands:
   ```
   /start
   /ping
   /status
   ```

3. Check health endpoint:
   - Visit `https://your-domain.railway.app/health`
   - Should show JSON with `"status": "healthy"`

### 4. Set Up Monitoring (5 minutes)

1. **UptimeRobot (Free):**
   - Visit [uptimerobot.com](https://uptimerobot.com)
   - Sign up for free
   - Add new HTTP(s) monitor
   - URL: `https://your-domain.railway.app/health`
   - Check interval: 5 minutes
   - Add email for alerts

2. **Configure Railway alerts:**
   - In Railway project → **Settings** → **Notifications**
   - Add email or Slack webhook
   - Enable deployment and error alerts

## 🎉 You're Done!

Your bot is now running 24/7 with monitoring!

### Quick Health Check

Run these commands in Telegram:
- `/status` - Check bot health
- `/stats` - View usage statistics
- `/ping` - Test responsiveness

### Monitor Health

- **Health endpoint:** `https://your-domain.railway.app/health`
- **Railway logs:** railway.app → Your project → Deployments → View Logs
- **UptimeRobot dashboard:** uptimerobot.com

## 🆘 Troubleshooting

### Bot not responding?

1. Check Railway logs for errors
2. Verify all environment variables are set
3. Test health endpoint
4. Try removing webhook variables (fallback to polling)

### Need help?

- Read [docs/monitoring.md](docs/monitoring.md) for detailed guide
- Check Railway logs
- Use `/status` command to diagnose

## 📊 What You Get

- ✅ 24/7 bot operation
- ✅ Automatic restarts if crashes
- ✅ Health monitoring
- ✅ Email alerts when down
- ✅ Usage statistics
- ✅ Detailed logging
- ✅ Free hosting (within limits)

## 💰 Cost

**Free tier (sufficient for personal use):**
- Railway: $5/month credit
- Typical usage: $0-2/month
- **Total: $0/month** (stays within free credit)

---

**Deployment time: ~15 minutes**
**Maintenance: ~5 minutes/month**

Enjoy your 24/7 personal assistant! 🤖
