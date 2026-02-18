# Troubleshooting Guide

Common issues and solutions for the Telegram bot.

## 🚨 Error: 409 Conflict - Multiple Bot Instances

### Error Message
```
TelegramError: 409: Conflict: terminated by other getUpdates request
```

### What This Means
You have **two or more bot instances running simultaneously**. Telegram only allows ONE active connection per bot token.

### Common Causes

1. **Bot running on Railway AND locally**
   - Railway deployment is active (webhook mode)
   - You're trying to run `npm run dev` locally (polling mode)
   - ❌ These conflict!

2. **Multiple local instances**
   - Forgot to stop previous `npm run dev`
   - Running bot in multiple terminals

3. **Webhook still active**
   - Deployed to Railway with webhook
   - Trying to run locally without deleting webhook

### Solutions

#### Option 1: Delete Webhook (Recommended for Local Development)

Use the webhook manager script:

```bash
# Check current webhook status
npm run webhook:info

# Delete webhook to enable local polling
npm run webhook:delete

# Now you can run locally
npm run dev
```

#### Option 2: Stop Railway Deployment

If you want to test locally:

1. Go to Railway dashboard
2. Find your project
3. Click **Settings** → **Pause Project**
4. Run `npm run dev` locally
5. Remember to unpause when done!

#### Option 3: Use Webhook Mode Locally (Advanced)

Not recommended unless you have a public URL (ngrok, etc.)

### Quick Manual Fix

If the scripts don't work, use curl:

```bash
# Replace YOUR_TOKEN with your actual bot token
curl -X POST "https://api.telegram.org/botYOUR_TOKEN/deleteWebhook"
```

---

## 🔍 Database Connection Errors

### Error: Connection Timeout

**Symptoms:**
- `/task` fails to save submitted tasks
- `/status` shows database disconnected
- Health endpoint shows unhealthy

**Solutions:**

1. **Check Supabase credentials:**
   ```bash
   # Verify .env file has correct values
   cat .env | grep SUPABASE
   ```

2. **Check Supabase project status:**
   - Log in to [supabase.com](https://supabase.com)
   - Verify project is active (not paused)
   - Check if you've exceeded free tier limits

3. **Test connection manually:**
   - Go to Supabase dashboard
   - Run a query in SQL Editor
   - If it works there, check your credentials

4. **Verify tables exist:**
   - Run the SQL from `docs/database-schema.sql`
   - Check that tables were created successfully

---

## 📝 Environment Variable Issues

### Error: Missing Required Environment Variable

**Symptoms:**
- Bot crashes on startup
- Error like `Missing required environment variable: TELEGRAM_BOT_TOKEN`

**Solutions:**

1. **Check .env file exists:**
   ```bash
   ls -la .env
   ```

2. **Verify all required variables:**
   ```bash
   # Required variables:
   TELEGRAM_BOT_TOKEN
   SUPABASE_URL
   SUPABASE_ANON_KEY
   ADMIN_USER_ID
   ```

3. **For Railway deployment:**
   - Go to project → **Variables** tab
   - Verify all variables are set
   - No quotes needed around values
   - Redeploy after adding variables

4. **Copy from example:**
   ```bash
   cp .env.example .env
   # Then edit .env with your values
   ```

---

## 🤖 Bot Not Responding to Commands

### Symptoms
- Send `/start` but no response
- Bot shows online but doesn't reply

### Solutions

1. **Check bot is running:**
   - Look for "✅ Bot is running!" in logs
   - Visit health endpoint: `https://your-domain/health`

2. **Check webhook status:**
   ```bash
   npm run webhook:info
   ```
   - If webhook URL is wrong, delete and reset it
   - Make sure webhook URL is HTTPS

3. **Check Telegram Bot token:**
   - Message @BotFather
   - Use `/token` to verify your token
   - Make sure you're messaging the correct bot

4. **Check Railway logs:**
   - Go to Deployments tab
   - Look for errors in logs
   - Check if bot is receiving webhook requests

5. **Test with /ping:**
   - If `/ping` works, bot is running
   - If no response, bot might be crashed

---

## 💾 Memory Issues

### Error: Out of Memory / High Memory Usage

**Symptoms:**
- Bot crashes randomly
- `/status` shows high memory percentage
- Railway shows memory alerts

**Solutions:**

1. **Check current memory:**
   ```bash
   # Use /status command
   /status
   ```

2. **Identify memory leak:**
   - Check if memory keeps growing over time
   - Look for unclosed database connections
   - Check for infinite loops in commands

3. **Optimize database queries:**
   - Limit query results (use `.limit()`)
   - Don't load entire command history at once
   - Add pagination for large results

4. **Clean up old data:**
   ```sql
   -- Delete old command history (keep last 10,000)
   DELETE FROM command_history
   WHERE id NOT IN (
     SELECT id FROM command_history
     ORDER BY created_at DESC
     LIMIT 10000
   );
   ```

5. **Upgrade Railway plan:**
   - Free tier: 512MB RAM
   - Hobby plan: 1GB RAM ($5/month)

---

## 🔐 Admin Commands Not Working

### Error: "This command is only available to administrators"

**Solutions:**

1. **Find your Telegram user ID:**
   - Message @userinfobot on Telegram
   - Copy the number

2. **Set ADMIN_USER_ID:**
   - Local: Add to `.env` file
   - Railway: Add to Variables tab
   - **Important:** No quotes around the number

3. **Verify admin ID is correct:**
   ```bash
   # Check what's set
   echo $ADMIN_USER_ID
   ```

4. **Restart bot after setting:**
   - Local: Stop and restart `npm run dev`
   - Railway: Will auto-restart when variable added

---

## 🌐 Webhook Issues

### Webhook Not Receiving Updates

**Check webhook is set:**
```bash
npm run webhook:info
```

**Common issues:**

1. **Wrong URL format:**
   - ❌ `http://my-bot.railway.app/webhook` (must be HTTPS)
   - ❌ `https://my-bot.railway.app` (missing /webhook path)
   - ✅ `https://my-bot.railway.app/webhook`

2. **Self-signed certificate:**
   - Railway provides valid SSL automatically
   - If using custom domain, ensure SSL is valid

3. **Port issues:**
   - Use port 3000 (or 80, 443, 88, 8443)
   - Railway automatically handles port mapping

**Test webhook manually:**
```bash
# Check if endpoint is accessible
curl https://your-domain.railway.app/health

# Should return JSON with bot status
```

---

## 📱 Commands Not Logging to Database

### Symptoms
- `/stats` shows 0 commands
- `command_history` table is empty

**Solutions:**

1. **Check table exists:**
   ```sql
   SELECT * FROM command_history LIMIT 5;
   ```

2. **Check table permissions:**
   - Supabase → Authentication → Policies
   - Ensure service role can insert

3. **Check for errors in logs:**
   - Look for "Failed to log command to database"
   - Database connection issues

4. **Manually test insert:**
   ```sql
   INSERT INTO command_history (user_id, command)
   VALUES (123456, '/test');
   ```

---

## 🐛 Build Errors

### TypeScript Compilation Errors

```bash
# Type check without building
npm run type-check

# Common fixes:
npm install           # Reinstall dependencies
rm -rf node_modules   # Clear node_modules
npm install           # Reinstall
npm run build         # Try build again
```

### Import Errors

**Error:** `Cannot find module './bot.js'`

**Solution:** Add `.js` extension to imports:
```typescript
// ❌ Wrong
import { Bot } from './bot';

// ✅ Correct
import { Bot } from './bot.js';
```

---

## 🚂 Railway Deployment Issues

### Build Failed

1. **Check build logs:**
   - Look for specific error messages
   - Common: missing dependencies, build script errors

2. **Verify package.json:**
   - `build` script exists
   - `start` script exists
   - All dependencies listed

3. **Check Node version:**
   - Railway uses Node 18 by default
   - Matches `engines` in package.json

### App Crashed After Deploy

1. **Check deployment logs:**
   - Look for startup errors
   - Missing environment variables

2. **Verify all variables set:**
   - Go to Variables tab
   - Ensure nothing is missing

3. **Check health endpoint:**
   - Visit `https://your-domain/health`
   - Should return 200 OK

---

## 📊 Monitoring Not Working

### UptimeRobot Shows Down

1. **Check health endpoint manually:**
   ```bash
   curl https://your-domain.railway.app/health
   ```

2. **Verify health check URL:**
   - Should end in `/health`
   - Must be HTTPS
   - Must return 200 status

3. **Check Railway is running:**
   - Log in to Railway
   - Check deployment status

### No Alerts Received

1. **Check UptimeRobot alert settings:**
   - Email address is correct
   - Alerts are enabled
   - Not in spam folder

2. **Test alert:**
   - Pause Railway project
   - UptimeRobot should detect downtime
   - You should receive email

---

## 🆘 Still Having Issues?

1. **Check logs:**
   - Local: Terminal output
   - Railway: Deployments → View Logs

2. **Test health endpoint:**
   ```bash
   curl https://your-domain/health
   ```

3. **Use admin commands:**
   ```
   /status  - Check bot health
   /stats   - Check if commands are logging
   ```

4. **Enable debug logging:**
   ```env
   NODE_ENV=development
   ```

5. **Create GitHub issue:**
   - Include error message
   - Include relevant logs (remove tokens!)
   - Describe what you were trying to do

---

## 📚 Quick Reference

### Useful Commands

```bash
# Check webhook
npm run webhook:info

# Delete webhook
npm run webhook:delete

# Run locally
npm run dev

# Build
npm run build

# Check types
npm run type-check
```

### Health Checks

- **Local:** `http://localhost:3000/health`
- **Production:** `https://your-domain.railway.app/health`
- **Bot status:** `/status` command on Telegram

### Important URLs

- Railway Dashboard: https://railway.app/dashboard
- Supabase Dashboard: https://supabase.com/dashboard
- UptimeRobot: https://uptimerobot.com/dashboard
- Telegram API: https://api.telegram.org/bot{TOKEN}/getWebhookInfo

---

**Most issues are solved by:**
1. Deleting the webhook (`npm run webhook:delete`)
2. Checking environment variables
3. Reading the logs
