# Deployment Guide

This guide covers multiple deployment options for your Telegram bot.

## 🚂 Railway.app (Recommended)

Railway offers the best balance of ease-of-use and cost-effectiveness for personal bots.

### Advantages
- ✅ Generous free tier ($5/month credit)
- ✅ Automatic deployments from GitHub
- ✅ Built-in environment variable management
- ✅ Custom domains included
- ✅ Easy monitoring and logs

### Setup Steps

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Initial bot setup"
   git push origin main
   ```

2. **Create Railway Project**
   - Visit [railway.app](https://railway.app)
   - Sign in with GitHub
   - Click **New Project** → **Deploy from GitHub repo**
   - Select your repository

3. **Configure Environment Variables**
   - Go to your project → **Variables** tab
   - Add:
     ```
     TELEGRAM_BOT_TOKEN=your_bot_token
     SUPABASE_URL=your_supabase_url
     SUPABASE_ANON_KEY=your_supabase_key
     SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
     NODE_ENV=production
     ```

4. **Optional: Enable Webhook Mode**
   - After first deployment, copy your Railway domain
   - Add these variables:
     ```
     WEBHOOK_DOMAIN=your-app.railway.app
     WEBHOOK_PORT=3000
     ```
   - Redeploy

5. **Deploy**
   - Railway automatically detects Node.js and runs `npm install && npm start`
   - Watch the deployment logs
   - Your bot should be live in ~2 minutes!

### Railway CLI (Optional)

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Link project
railway link

# Add variables
railway variables set TELEGRAM_BOT_TOKEN=your_token

# Deploy
railway up
```

---

## 🌊 Render.com

Render has a free tier with some limitations (spins down after inactivity).

### Setup Steps

1. **Create Web Service**
   - Visit [render.com](https://render.com)
   - Click **New** → **Web Service**
   - Connect your GitHub repo

2. **Configure**
   - **Environment:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** Free

3. **Environment Variables**
   - Add all required variables in Render dashboard

4. **Deploy**
   - Render will build and deploy automatically

⚠️ **Note:** Free tier spins down after 15 minutes of inactivity. First request after spin-down takes ~30 seconds. Use polling mode to handle this.

---

## 📦 DigitalOcean App Platform

Good for scaling beyond free tier.

### Pricing
- ~$5/month for basic apps

### Setup

1. Create new app from GitHub
2. Set environment variables
3. Deploy

---

## 🐳 Docker Deployment

For VPS or any Docker-compatible host.

### Create Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

CMD ["npm", "start"]
```

### Create docker-compose.yml

```yaml
version: '3.8'

services:
  bot:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - NODE_ENV=production
```

### Deploy

```bash
docker-compose up -d
```

---

## ☁️ AWS Lambda (Advanced)

For serverless deployment with webhook mode.

### Requirements
- AWS account
- AWS CLI configured
- Terraform or SAM (recommended)

### Architecture
- Lambda function for webhook endpoint
- API Gateway for HTTPS endpoint
- Set Lambda environment variables

### Considerations
- More complex setup
- Best for high-traffic bots
- Very cost-effective at scale
- Cold start latency (~1-2 seconds)

---

## 🖥️ Self-Hosted (VPS)

For complete control.

### Setup on Ubuntu/Debian

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone your-repo
cd my-helper
npm install
npm run build

# Create systemd service
sudo nano /etc/systemd/system/telegram-bot.service
```

### Systemd Service File

```ini
[Unit]
Description=My Helper Telegram Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/my-helper
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always

[Install]
WantedBy=multi-user.target
```

### Start Service

```bash
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot
sudo systemctl status telegram-bot
```

---

## 📊 Monitoring

### Railway/Render
- Built-in logs and metrics
- Check deployment logs for errors

### Self-Hosted
```bash
# View logs
sudo journalctl -u telegram-bot -f

# Check status
sudo systemctl status telegram-bot
```

### Health Check
Send `/ping` to your bot to verify it's responsive.

---

## 🔄 Continuous Deployment

### GitHub Actions (for VPS)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Bot

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Deploy to VPS
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd ~/my-helper
            git pull
            npm install
            npm run build
            sudo systemctl restart telegram-bot
```

---

## 🆘 Troubleshooting

### Bot Not Responding
1. Check logs for errors
2. Verify `TELEGRAM_BOT_TOKEN` is correct
3. Test with `/ping` command
4. Check if service is running

### Database Errors
1. Verify Supabase credentials
2. Check tables exist (run schema SQL)
3. Test Supabase connection in dashboard

### Webhook Not Working
1. Ensure `WEBHOOK_DOMAIN` uses HTTPS
2. Port must be 80, 443, 88, or 8443
3. Check Railway/Render logs for webhook requests
4. Fallback to polling mode if issues persist

### High Latency
1. Check Railway/Render region (choose closest to you)
2. Consider upgrading from free tier
3. Use webhook mode instead of polling

---

## 💡 Best Practices

1. **Use Webhook Mode in Production** - More efficient than polling
2. **Monitor Logs Regularly** - Catch errors early
3. **Set up Alerts** - Use Railway/Render notifications
4. **Backup Database** - Supabase has automatic backups
5. **Version Control** - Never commit `.env` file
6. **Rate Limiting** - Implement if bot becomes popular

---

## 📈 Scaling Tips

If your bot grows beyond personal use:

1. **Upgrade Hosting Plan** - Move from free tier
2. **Add Redis Caching** - For frequently accessed data
3. **Implement Queue System** - For long-running tasks
4. **Use CDN** - If serving media files
5. **Load Balancing** - Multiple bot instances
6. **Database Optimization** - Add indexes, use connection pooling

---

**Choose Railway for the easiest start, then scale as needed!**
