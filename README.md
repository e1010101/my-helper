# My Helper Bot 🤖

A powerful, extensible Telegram bot for personal assistance, built with TypeScript and modern cloud services.

## ✨ Features

- 🔐 **Secure** - User-specific data storage with Supabase
- 🧠 **Persistent memory** - Conversations, facts and reminders live in Postgres, not RAM
- ⏰ **Reminders** - "remind me in 30 minutes", "every Monday at 9am", with timezone-correct scheduling
- 🤝 **Confirm-before-write** - The assistant proposes actions; nothing changes your data until you tap Confirm
- 📝 **Task Capture** - Create, edit and persist to-do tasks
- 💬 **AI Chat** - Free-form messages are answered by a configurable model (DeepSeek by default), with tools for your own data
- 📄 **Prompt Library** - Save prompt templates with tags and an image, then search them
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
- **AI:** [DeepSeek](https://platform.deepseek.com/) (`deepseek-chat`) by default; Google Gemini also supported via `AI_PROVIDER`
- **Hosting:** [Railway.app](https://railway.app/) (recommended, free tier available)
- **Runtime:** Node.js 20+

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 20 or higher
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
- `/task` - Manage to-do tasks (see [`/task` Usage](#task-usage))
- `/tasks` - List your saved tasks
- `/prompt` - Create a prompt template (title, text, tags, image)
- `/getprompt` - Search your saved prompts
- `/forget` - Clear conversation memory (facts and reminders survive)
- `/memory` - Show the facts, reminders and message count the assistant holds

**Admin Commands** (requires `ADMIN_USER_ID`):
- `/status` - Check bot health, uptime, and system status
- `/stats` - View usage statistics and top commands

### Talking to the assistant

Any plain text message is handled by the configured model, which can call tools against your own data:

| You say | What happens |
| --- | --- |
| "what time is it?" | Read tool runs immediately |
| "remember I'm allergic to peanuts" | Proposes `save_fact`, waits for your Confirm tap |
| "remind me to call mum tomorrow at 7:30am" | Proposes `create_reminder`, then schedules it |
| "what do you remember about me?" | Reads back facts and reminders |

**Nothing that writes your data happens without an explicit Confirm tap.** Read-only
questions are answered directly. Confirmations expire after 10 minutes.

Reminders are stored in Postgres and polled by a scheduler, so they survive restarts;
a reminder that came due while the bot was offline is delivered marked "(missed earlier)".

### Model providers

The assistant speaks to whichever provider you configure:

```ini
DEEPSEEK_API_KEY=...      # default provider
DEEPSEEK_MODEL=deepseek-chat
# GEMINI_API_KEY=...      # alternative
AI_PROVIDER=deepseek      # optional; inferred when only one key is set
```

`deepseek-chat` is the default because the assistant tools require **function calling**.
If both keys are set without `AI_PROVIDER`, startup fails rather than silently guessing.
Adding another provider means implementing the `AIClient` interface in
`src/services/ai-client.ts`.

### `/task` Usage

`/task` always takes a flag:

| Command | Effect |
| --- | --- |
| `/task -create` | Opens the interactive form to create a task |
| `/task -read <id>` | Shows full details of one task |
| `/task -read all` | Lists all your tasks (same as `/tasks`) |
| `/task -update <id>` | Opens the form pre-filled with that task |
| `/task -delete <id>` | Deletes that task |

Running `/task` with no flag prints the usage summary.

Form flow:

1. Send `/task -create`
2. Tap `Name`, then send the task name as your next message
3. Tap `Description`, then send the description as your next message
4. Tap `Submit` to save the task

Expected behavior:
- The bot keeps one in-progress task draft per user while filling the form.
- `Submit` is blocked until both `Name` and `Description` are provided.
- On success, the bot confirms with `✅ Task created!` and persists the task in the `tasks` table.
- If saving fails, the bot responds with an error and keeps the draft so you can retry.

### `/tasks` Usage

1. Send `/tasks`
2. Bot returns your most recent saved tasks (up to 20), newest first
3. Use the inline keyboard buttons (e.g., `[1]`, `[2]`) below the message to toggle tasks as completed (✅) or uncompleted (⬜)

### `/prompt` Usage

1. Send `/prompt`
2. Send the **title** as your next message
3. Send the **prompt text**
4. Send comma-separated **tags**, or `skip`
5. Send an **image** — the highest available resolution is stored (as a Telegram `file_id`)

Sending text instead of an image at the last step cancels the draft, so a half-finished
prompt never traps your later messages.

### `/getprompt` Usage

```text
/getprompt -title <text>
/getprompt -tag <tag1,tag2>
/getprompt -title <text> -tag <tag1,tag2>
```

Title search is a case-insensitive substring match; tag search requires all given tags
(PostgreSQL array containment). Results are shown one per photo with `⬅️ Previous` /
`Next ➡️` pagination.

## 🛠️ Development

### Project Structure

```
my-helper/
├── src/
│   ├── config/
│   │   └── env.ts              # Lazy environment configuration
│   ├── services/
│   │   ├── database.ts         # Task/prompt database operations
│   │   ├── assistant-store.ts  # AssistantStore interface (+ Clock)
│   │   ├── supabase-assistant-store.ts   # Postgres-backed memory/facts/reminders
│   │   ├── in-memory-assistant-store.ts  # Test/fallback implementation
│   │   ├── assistant.ts        # Conversation loop + tool confirmations
│   │   ├── gemini-client.ts    # Gemini API wrapper (AIClient interface)
│   │   ├── reminder-time.ts    # Timezone maths + natural-language time parsing
│   │   ├── reminder-scheduler.ts # Polls and delivers due reminders
│   │   ├── health.ts           # Health snapshot for /health and /status
│   │   └── logger.ts           # Leveled console logger
│   ├── tools/
│   │   ├── registry.ts         # Tool registry + argument validation
│   │   └── builtin-tools.ts    # The tools the model may call
│   ├── commands/
│   │   ├── index.ts            # Core command handlers
│   │   ├── assistant-commands.ts # /forget, /memory
│   │   ├── prompt.ts           # /prompt creation flow
│   │   └── getprompt.ts        # /getprompt search + pagination
│   ├── types/
│   │   └── assistant.ts        # Shared assistant data shapes
│   ├── utils/
│   │   └── telegram-format.ts  # HTML escaping + Markdown→Telegram HTML
│   ├── bot.ts                  # Bot setup, middleware, HTTP server, wiring
│   └── index.ts                # Entry point
├── scripts/
│   └── webhook-manager.ts      # Telegram webhook CLI
├── tests/                      # node:test suites (npm test)
├── docs/
│   ├── database-schema.sql     # Supabase table definitions
│   └── deployment.md           # Deployment guides
├── .env.example                # Environment template
├── package.json
├── tsconfig.json               # Build config (emits to dist/)
└── tsconfig.check.json         # Type-check config (src + scripts + tests, no emit)
```

### Tests

```bash
npm test          # node:test suites under tests/
```

The assistant layer is built around interfaces (`AssistantStore`, `AIClient`,
`ToolRegistry`) with in-memory implementations, so the reminder scheduler, the tool
loop and the time maths are all tested without a live database, Telegram or Gemini.

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
npm test            # Run the test suites
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
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `DEEPSEEK_API_KEY`
   - `NODE_ENV=production`
   - `ADMIN_USER_ID` (your Telegram user ID from @userinfobot)
   - `TIMEZONE` (e.g. `Asia/Singapore`)
6. Railway will automatically deploy your bot

For webhook mode (more efficient than polling):
- Add `WEBHOOK_DOMAIN` (your Railway domain, e.g., `mybot.railway.app`)
- Add `WEBHOOK_SECRET` (any random `A-Za-z0-9_-` string) so only Telegram can post to `/webhook`

Do **not** set the port yourself: Railway injects `PORT`, and the bot prefers it over
`WEBHOOK_PORT`. The HTTP server binds to `0.0.0.0` so platform healthchecks can reach it.

**📖 Deployment Guides:**
- **Quick start:** [DEPLOY.md](DEPLOY.md) - 15-minute deployment guide
- **Detailed guide:** [docs/deployment.md](docs/deployment.md) - All hosting options
- **Monitoring:** [docs/monitoring.md](docs/monitoring.md) - 24/7 monitoring setup

## 📊 Monitoring & Health Checks

The bot includes comprehensive monitoring features:

### Health Endpoint
- **`/health`** (and `/`) — liveness. Returns 200 while the process is serving and can
  reach Telegram. A database outage is reported in the body but does not fail this
  check, because restarting cannot repair a database and a crash loop would take the
  bot down rather than degrade it. This is what Railway's healthcheck uses.
- **`/ready`** — readiness. Returns 503 unless the database is genuinely writable
  (verified with a write probe, since RLS makes reads look fine when they are not).
  Use this one for UptimeRobot or any external monitor.
- Reports `unhealthy` (HTTP 503) if the Telegram API or any required table is unreachable
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

The bot requires these Supabase tables:

- `user_data` - Stores user-specific key-value data
- `command_history` - Logs command usage for analytics
- `tasks` - Stores to-do tasks created from `/task`
- `prompts` - Stores prompt templates (`title`, `prompt`, `tags`, `image_file_id`) from `/prompt`
- `conversations` - Assistant conversation memory
- `facts` - Long-lived facts and preferences
- `reminders` - Scheduled reminders
- `pending_actions` - Write-tool confirmations awaiting a tap
- `credentials` - Provider tokens (service_role only)
- `health_probes` - Single fixed row the `/ready` write probe upserts

Run the SQL from `docs/database-schema.sql` in your Supabase SQL Editor to create these tables.
The health endpoint reports `unhealthy` if any of them is missing.

Or apply it from the command line (needs `psql` on PATH and `DATABASE_URL` in `.env`):

```bash
npm run db:migrate
```

The script applies the schema, then prints per-table status including which tables have
Row Level Security enabled, so you can confirm the migration took effect.

Before deploying — or whenever something looks wrong — run the preflight check:

```bash
npm run preflight
```

It verifies every required variable, that the Telegram token works, that all ten tables
exist, that the service-role key can actually write to the RLS-protected tables, that the
anon key is correctly refused, that the configured model answers, and that reminders have
a delivery destination. Read-only against your data.

**Row Level Security:** `conversations`, `facts`, `reminders`, `pending_actions` and
`credentials` have RLS enabled with only a `service_role` policy, so they are unreadable
with the public key. Set `SUPABASE_SERVICE_ROLE_KEY` or the assistant features will fail —
`/health` will tell you exactly that.

## 🔒 Security

- Never commit your `.env` file
- Keep your bot token and Supabase keys secret
- Use Supabase Row Level Security (RLS) for production
- The bot only stores data you explicitly submit (for example via `/task`)

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
