# My Helper Bot 🤖

A powerful, extensible Telegram bot for personal assistance, built with TypeScript and modern cloud services.

## ✨ Features

- 🔐 **Secure** - User-specific data storage with Supabase
- 📝 **Persistent Storage** - Save and retrieve personal notes and data
- 🚀 **Fast** - Built with Telegraf, one of the fastest Telegram bot frameworks
- 🔧 **Extensible** - Easy-to-add command system
- 📊 **Analytics** - Command usage tracking and statistics
- 🏥 **Health Monitoring** - Built-in health checks and status endpoints
- 🔔 **Alerting** - Integration with UptimeRobot and other monitoring services
- ⚙️ **Admin Tools** - Real-time status and statistics commands
- 📝 **Logging** - Comprehensive logging with different severity levels
- ☁️ **Cloud-Native** - Designed for 24/7 deployment on Railway/PaaS platforms

## 🏗️ Tech Stack

- **Language:** TypeScript
- **Bot Framework:** [Telegraf](https://telegraf.js.org/)
- **Database:** [Supabase](https://supabase.com/) (PostgreSQL)
- **Hosting:** [Railway.app](https://railway.app/) (recommended, free tier available)
- **Runtime:** Node.js 18+

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 18 or higher
- A Telegram account
- A Supabase account (free tier is sufficient)

### 2. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the instructions
3. Save the bot token you receive

### 3. Set Up Supabase

1. Create a free account at [supabase.com](https://supabase.com)
2. Create a new project
3. Go to **Project Settings** → **API** and copy:
   - Project URL
   - `anon` `public` key
4. Go to **SQL Editor** and run the schema from `docs/database-schema.sql`

### 4. Install and Configure

```bash
# Clone the repository
git clone https://github.com/yourusername/my-helper.git
cd my-helper

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your tokens and keys
```

### 5. Run the Bot

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build
npm start
```

## 📝 Available Commands

**User Commands:**
- `/start` - Welcome message and introduction
- `/help` - List all available commands
- `/ping` - Check bot responsiveness
- `/save <key> <value>` - Save data to your personal storage
- `/get <key>` - Retrieve saved data

**Admin Commands:**
- `/status` - Check bot health, uptime, and system status
- `/stats` - View usage statistics and top commands

## 🛠️ Development

### Project Structure

```
my-helper/
├── src/
│   ├── config/
│   │   └── env.ts           # Environment configuration
│   ├── services/
│   │   └── database.ts      # Database operations
│   ├── commands/
│   │   └── index.ts         # Command handlers
│   ├── bot.ts               # Bot setup and middleware
│   └── index.ts             # Entry point
├── docs/
│   ├── database-schema.sql  # Supabase table definitions
│   └── deployment.md        # Deployment guides
├── .env.example             # Environment template
├── package.json
└── tsconfig.json
```

### Adding New Commands

1. Open `src/commands/index.ts`
2. Create a new command handler function:

```typescript
async function myCommand(ctx: Context) {
  await ctx.reply('Hello from my command!');
}
```

3. Register it in `registerCommands()`:

```typescript
bot.command('mycommand', myCommand);
```

4. Update the help text in `helpCommand()`

### Development Commands

```bash
npm run dev         # Start with hot reload
npm run build       # Compile TypeScript
npm run lint        # Run ESLint
npm run type-check  # Type check without building
```

## 🌐 Deployment

### Railway.app (Recommended)

Railway offers a generous free tier perfect for personal bots.

1. Push your code to GitHub
2. Visit [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project** → **Deploy from GitHub repo**
4. Select your repository
5. Add environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `NODE_ENV=production`
6. Railway will automatically deploy your bot

For webhook mode (more efficient):
- Add `WEBHOOK_DOMAIN` (your Railway domain, e.g., `mybot.railway.app`)
- Add `WEBHOOK_PORT=3000`
- Add `ADMIN_USER_ID` (your Telegram user ID from @userinfobot)

**📖 Deployment Guides:**
- **Quick start:** [DEPLOY.md](DEPLOY.md) - 15-minute deployment guide
- **Detailed guide:** [docs/deployment.md](docs/deployment.md) - All hosting options
- **Monitoring:** [docs/monitoring.md](docs/monitoring.md) - 24/7 monitoring setup

## 📊 Monitoring & Health Checks

The bot includes comprehensive monitoring features:

### Health Endpoint
- **URL:** `https://your-domain.railway.app/health`
- Returns JSON with bot status, uptime, memory usage, and database connectivity
- Use with UptimeRobot or Better Uptime for 24/7 monitoring

### Admin Commands
- `/status` - Real-time bot health (uptime, memory, connections)
- `/stats` - Usage statistics (total users, commands, top commands)

### Logging
- Structured logs with timestamps and severity levels
- View logs in Railway dashboard or stdout
- Automatic command tracking to database

**See [docs/monitoring.md](docs/monitoring.md) for complete monitoring setup guide.**

## 💾 Database Schema

The bot requires two Supabase tables:

- `user_data` - Stores user-specific key-value data
- `command_history` - Logs command usage for analytics

Run the SQL from `docs/database-schema.sql` in your Supabase SQL Editor to create these tables.

## 🔒 Security

- Never commit your `.env` file
- Keep your bot token and Supabase keys secret
- Use Supabase Row Level Security (RLS) for production
- The bot only stores data you explicitly save with `/save`

## 🤝 Contributing

This is a personal project, but suggestions are welcome! Feel free to open issues or submit pull requests.

## 📄 License

MIT

## 🆘 Support

For issues or questions:
1. Check existing [GitHub Issues](https://github.com/yourusername/my-helper/issues)
2. Read the [docs/](docs/) folder
3. Open a new issue if needed

---

**Built with ❤️ for personal productivity**

