# Monitoring & 24/7 Deployment Guide

This guide explains how to deploy your bot for 24/7 operation and set up comprehensive monitoring.

## 🚀 Deploying to Railway (24/7 Operation)

### Step 1: Prepare Your Repository

1. **Commit all changes:**
   ```bash
   git add .
   git commit -m "Add monitoring and deployment configuration"
   git push origin main
   ```

2. **Find your Telegram user ID:**
   - Message [@userinfobot](https://t.me/userinfobot) on Telegram
   - Save your user ID for admin commands

### Step 2: Deploy to Railway

1. **Sign up for Railway:**
   - Visit [railway.app](https://railway.app)
   - Sign in with GitHub
   - You get $5/month free credit (plenty for personal use)

2. **Create new project:**
   - Click **New Project** → **Deploy from GitHub repo**
   - Select your `my-helper` repository
   - Railway will automatically detect it's a Node.js app

3. **Configure environment variables:**
   - Go to your project → **Variables** tab
   - Add all required variables:
     ```
     TELEGRAM_BOT_TOKEN=your_token_from_botfather
     ADMIN_USER_ID=your_telegram_user_id
     SUPABASE_URL=your_supabase_project_url
     SUPABASE_ANON_KEY=your_supabase_anon_key
     NODE_ENV=production
     ```

4. **Get your Railway domain:**
   - After deployment, go to **Settings** → **Networking**
   - Click **Generate Domain**
   - Copy the domain (e.g., `my-helper-production.up.railway.app`)

5. **Enable webhook mode (recommended):**
   - Add these additional variables:
     ```
     WEBHOOK_DOMAIN=my-helper-production.up.railway.app
     WEBHOOK_PORT=3000
     ```
   - Redeploy (Railway will auto-redeploy on variable changes)

6. **Verify deployment:**
   - Check the **Deployments** tab for logs
   - Look for "✅ Bot is running!" in the logs
   - Visit `https://your-domain.railway.app/health` to see health status

### Step 3: Test Your Bot

Message your bot on Telegram - it should now respond 24/7! 🎉

---

## 📊 Built-in Monitoring Features

Your bot now includes several monitoring features:

### 1. Health Check Endpoint

**URL:** `https://your-domain.railway.app/health`

Returns detailed health information:
```json
{
  "status": "healthy",
  "uptime": 3600000,
  "timestamp": "2024-02-16T10:30:00.000Z",
  "bot": {
    "connected": true,
    "mode": "webhook"
  },
  "database": {
    "connected": true,
    "latency": 45
  },
  "system": {
    "memory": {
      "used": 50,
      "total": 512,
      "percentage": 10
    },
    "platform": "linux",
    "nodeVersion": "v18.19.0"
  }
}
```

**Use cases:**
- Check if bot is running
- Monitor memory usage
- Verify database connectivity
- Track uptime

### 2. Admin Commands

Send these commands to your bot (admin only):

**`/status`** - Real-time bot health:
```
✅ Bot Status

Uptime: 2h 15m 30s
Status: HEALTHY

Components:
✅ Bot: Connected (webhook)
✅ Database: Connected (45ms)

System:
💾 Memory: 50MB / 512MB (10%)
🖥️ Platform: linux
⚙️ Node: v18.19.0

Last Check: 2/16/2024, 10:30:00 AM
```

**`/stats`** - Usage statistics:
```
📊 Usage Statistics

Overall:
👥 Total Users: 5
📝 Total Commands: 142

Top Commands (last 100):
1. /ping: 25×
2. /task: 18×
3. /help: 15×
4. /status: 12×
5. /start: 8×
```

### 3. Enhanced Logging

All operations are logged with timestamps and metadata:

```
[2024-02-16T10:30:00.000Z] [INFO] Starting bot in webhook mode
[2024-02-16T10:30:05.000Z] [INFO] Command executed: /ping {"userId":123456,"username":"john"}
[2024-02-16T10:30:10.000Z] [ERROR] Database connection failed {"message":"Connection timeout"}
```

**View logs on Railway:**
- Go to your project → **Deployments**
- Click on latest deployment → **View Logs**
- Real-time log streaming

---

## 🔔 External Monitoring Setup

### Option 1: UptimeRobot (Recommended - Free)

**Why:** Free, reliable, email/SMS alerts when bot goes down

**Setup:**
1. Visit [uptimerobot.com](https://uptimerobot.com)
2. Sign up for free account
3. Add new monitor:
   - **Type:** HTTP(s)
   - **URL:** `https://your-domain.railway.app/health`
   - **Name:** My Helper Bot
   - **Interval:** 5 minutes (free tier)
4. Configure alerts:
   - Add email address
   - Optional: Add Telegram/Slack webhook
5. Save monitor

**What it does:**
- Checks `/health` every 5 minutes
- Sends alert if bot is down
- Shows uptime percentage
- Free SSL monitoring

### Option 2: Better Uptime (Free tier available)

**Why:** Better UI, more alerting options

**Setup:**
1. Visit [betteruptime.com](https://betteruptime.com)
2. Sign up (free for 1 monitor)
3. Create monitor:
   - **URL:** `https://your-domain.railway.app/health`
   - **Check frequency:** 30 seconds (free tier)
   - **Expected status code:** 200
4. Configure incident alerts
5. Optional: Set up status page

### Option 3: Railway's Built-in Monitoring

**Railway automatically monitors:**
- CPU usage
- Memory usage
- Network traffic
- Deployment status

**View metrics:**
- Go to project → **Metrics** tab
- See real-time graphs

**Set up alerts:**
- Go to project → **Settings** → **Notifications**
- Add email or Slack webhook
- Configure alert thresholds

---

## 🐛 Error Tracking with Sentry (Optional)

For advanced error tracking and debugging:

### Setup Sentry

1. **Create Sentry account:**
   - Visit [sentry.io](https://sentry.io)
   - Sign up (free tier available)
   - Create new project (Node.js)

2. **Install Sentry:**
   ```bash
   npm install @sentry/node
   ```

3. **Add to your code** (in `src/index.ts`):
   ```typescript
   import * as Sentry from '@sentry/node';

   Sentry.init({
     dsn: process.env.SENTRY_DSN,
     environment: process.env.NODE_ENV,
     tracesSampleRate: 1.0,
   });
   ```

4. **Add SENTRY_DSN to Railway variables:**
   ```
   SENTRY_DSN=your_sentry_dsn
   ```

5. **Wrap errors:**
   ```typescript
   try {
     // Your code
   } catch (error) {
     Sentry.captureException(error);
     logger.error('Error occurred', error);
   }
   ```

**Benefits:**
- Automatic error grouping
- Stack traces
- Release tracking
- Performance monitoring
- User context

---

## 📈 Monitoring Dashboard Options

### Option 1: Simple Admin Commands

Use `/status` and `/stats` commands directly in Telegram for quick checks.

### Option 2: Custom Status Page

Create a simple status page:

1. **Update health endpoint** to return HTML:
   ```typescript
   if (req.headers.accept?.includes('text/html')) {
     // Return HTML page
   }
   ```

2. **Deploy status page:**
   - Visit `https://your-domain.railway.app/health` in browser
   - Shows visual status dashboard

### Option 3: Grafana + Prometheus (Advanced)

For serious monitoring:
- Set up Prometheus metrics endpoint
- Deploy Grafana
- Create custom dashboards
- Track detailed metrics

---

## 🔍 Monitoring Checklist

After deployment, verify:

- [ ] Bot responds to messages on Telegram
- [ ] `/health` endpoint returns 200 OK
- [ ] `/status` command shows healthy status
- [ ] UptimeRobot monitor is active
- [ ] Railway logs show no errors
- [ ] Database connection is stable
- [ ] Webhook is receiving updates (check logs)
- [ ] Admin commands work (`/status`, `/stats`)

---

## 🚨 Troubleshooting

### Bot Not Responding

1. **Check Railway logs:**
   - Look for errors during startup
   - Verify "Bot is running!" message

2. **Check environment variables:**
   - Ensure `TELEGRAM_BOT_TOKEN` is correct
   - Verify all required variables are set

3. **Check health endpoint:**
   - Visit `/health` URL
   - Should return `"status": "healthy"`

4. **Verify webhook (if enabled):**
   - Check Railway logs for webhook requests
   - Telegram should send POST requests to `/webhook`

5. **Test with polling mode:**
   - Remove `WEBHOOK_DOMAIN` variable
   - Redeploy
   - Check if bot works in polling mode

### High Memory Usage

1. **Check `/status` command:**
   - Look at memory percentage
   - Railway free tier has 512MB limit

2. **Optimize if needed:**
   - Clear command history periodically
   - Limit database query results
   - Add memory limits to Node.js

3. **Upgrade Railway plan:**
   - If consistently hitting limits
   - $5/month gives 1GB RAM

### Database Connectivity Issues

1. **Check Supabase:**
   - Verify project is active
   - Check API keys are correct

2. **Test connection:**
   - Use `/status` command
   - Check database latency

3. **Check Supabase logs:**
   - Go to Supabase dashboard → Logs
   - Look for connection errors

### Webhook Not Working

1. **Verify domain:**
   - Must use HTTPS (Railway provides this)
   - No trailing slashes

2. **Check Telegram webhook:**
   - Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo`
   - Should show your Railway URL

3. **Fallback to polling:**
   - Remove webhook variables
   - Redeploy

---

## 💰 Cost Breakdown

**Free tier (sufficient for personal use):**
- Railway: $5/month credit (more than enough)
- Supabase: Free 500MB database
- UptimeRobot: Free monitoring (5-minute checks)
- Total: $0/month

**Paid tier (if needed):**
- Railway: $5/month (~8GB transfer, 1GB RAM)
- Supabase: Free tier is usually sufficient
- Better Uptime: $10/month (more monitors)
- Sentry: $26/month (advanced error tracking)

For personal use, you should stay within free limits!

---

## 📱 Quick Monitoring Routine

**Daily (Automated):**
- UptimeRobot checks health every 5 minutes
- Railway monitors resources
- Alerts sent if issues detected

**Weekly (Manual - 2 minutes):**
1. Message bot with `/status`
2. Check uptime and memory
3. Review Railway metrics

**Monthly (Manual - 5 minutes):**
1. Check `/stats` for usage trends
2. Review Railway billing
3. Check Supabase database size
4. Update dependencies if needed

---

## 🎉 You're All Set!

Your bot is now running 24/7 with comprehensive monitoring. You'll receive alerts if anything goes wrong, and you can check status anytime with admin commands.

**Next steps:**
- Add more custom commands
- Expand monitoring as needed
- Scale up if bot becomes popular

**Need help?** Check Railway logs and use `/status` command to diagnose issues.

---

**Happy monitoring! 🚀**
