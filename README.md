# My Helper Bot 🤖

A powerful, extensible Telegram bot for personal assistance, built with TypeScript and modern cloud services.

## ✨ Features

- 🔐 **Secure** - User-specific data storage with Supabase
- 🧠 **Persistent memory** - Conversations, facts and reminders live in Postgres, not RAM
- ⏰ **Actionable reminders** - Timezone-correct schedules with Done, Snooze, Skip, quiet hours and opt-in follow-ups
- 🤝 **Confirm-before-write** - AI-proposed changes require a Confirm tap; explicit forms save on Submit or Save
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
- **Runtime:** Node.js 22.13+ (22.x), or Node.js 24+

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 22.13+ (22.x), or Node.js 24+
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
- `/tasks` - List your saved to-dos and active reminders (including recurring schedules)
- `/pending` - Show pending reminder occurrences with Done, Snooze and Skip controls
- `/reminders` - Configure quiet hours and opt-in follow-ups
- `/prompt` - Create a prompt template (title, text, tags, image)
- `/getprompt` - Search your saved prompts
- `/forget` - Clear conversation memory (facts and reminders survive)
- `/memory` - Show the facts, reminders and message count the assistant holds

**Admin Commands** (requires `ADMIN_USER_ID`):
- `/status` - Check bot health, uptime, and system status
- `/stats` - View usage statistics and top commands

Typing `/` in Telegram shows this list as a menu, published automatically on every
startup from [src/commands/catalog.ts](src/commands/catalog.ts) — the same source that
builds `/help`, so the two cannot drift apart. Admin commands appear in your own chat
only, not for anyone else.

### Talking to the assistant

Any plain text message is handled by the configured model, which can call tools against your own data:

| You say | What happens |
| --- | --- |
| "what time is it?" | Read tool runs immediately |
| "remember I'm allergic to peanuts" | Proposes `save_fact`, waits for your Confirm tap |
| "remind me to call mum tomorrow at 7:30am" | Proposes `create_reminder`, then schedules it |
| "what do you remember about me?" | Reads back facts and reminders |
| "what's the weather like?" | Current conditions for your stored home city |
| "will it rain on Saturday?" | Multi-day outlook, up to 7 days |

**AI-proposed changes require an explicit Confirm tap.** Read-only questions are
answered directly; conversation history is saved automatically. Explicit commands and
forms use their own controls. Confirmations expire after 10 minutes and are atomically
consumed before execution, so repeat taps cannot execute the same action twice. If a
write's outcome is uncertain, check your saved data before asking again.

Relative times use the original message's timestamp. ISO dates without an offset use
the configured timezone. Daily and single-weekday recurrence are supported; requests
such as "every weekday" are rejected rather than silently scheduled on Monday only.

Reminders and their pending occurrences are stored in Postgres and polled by a scheduler,
so they survive restarts. Overdue deliveries retain their original scheduled timestamp.

### Actionable reminders

Each delivery shows its complete text, occurrence ID, scheduled time and timezone, with
**Done**, **Skip**, **Snooze 10m**, **Snooze 1h** and **Tomorrow 09:00** buttons.
Tomorrow means 09:00 on the next calendar day in `TIMEZONE`. Done and Skip close only
that occurrence; snoozing moves only its next notification. Recurring schedules continue
independently, and older deliveries cannot act on a newer occurrence.

Open `/pending` to recover the controls after a restart or find an unanswered one-off
reminder whose schedule has already become inactive. It shows up to 50 pending
occurrences at a time; handling them reveals the remaining items. `/tasks` links to this
list and continues to manage the underlying schedules. Cancelling or deleting a reminder
also cancels its pending occurrences and queued notifications, while retaining history.

Quiet hours and automatic follow-ups both default to **off** and are saved per user:

| Command | Effect |
| --- | --- |
| `/reminders` | Show current preferences and explicit follow-up ON/OFF buttons |
| `/reminders quiet 22:00 08:00` | Defer notifications during this overnight period in `TIMEZONE` |
| `/reminders quiet off` | Disable quiet hours |
| `/reminders followups on` | Opt into follow-ups for future deliveries |
| `/reminders followups off` | Disable follow-ups and clear already queued follow-ups |

Quiet hours require two different `HH:MM` times and apply to initial reminders,
snoozes and follow-ups. Due notifications wait until the quiet period ends. Opt-in
follow-ups are limited to **two per occurrence**, **60 minutes apart**, and **five
attempts per user per local day**; failed attempts consume the daily budget too.
Enabling follow-ups does not automatically rearm older pending occurrences. You can always
use `/pending` and Snooze explicitly, whether automatic follow-ups are enabled or not.

Delivery is at least once: a crash or uncertain Telegram response after a message is
accepted but before delivery is recorded can cause a duplicate. Database leases prevent
concurrent workers from normally sending the same occurrence, and versioned buttons
prevent repeated or stale actions from changing it twice. An already in-flight message
cannot be recalled by Done, Skip, cancellation, or a preference change.

### Weather

Weather uses [Open-Meteo](https://open-meteo.com/), which needs **no API key** — so there
is no fourth credential to provision or rotate.

Ask without naming a place and it falls back to your stored home city, which is why that
fact is worth marking as `core`:

> "remember as core: my home city is Singapore"
> "what's the weather like?" → answered for Singapore

Naming a place explicitly always wins, and an unrecognised place is reported back to the
model as unknown rather than guessed at — it will ask which place you meant instead of
inventing one.

Two read tools are added: `get_weather` (current conditions plus today) and
`get_forecast` (up to 7 days, for planning questions). Both are read-only, so neither
prompts for confirmation. Results are cached for 10 minutes, so asking twice in a row
costs one API call.

Two tool declarations is not free: they add roughly **257 prompt tokens to every
request**, which is why the tool set is kept deliberately small.

## 📊 Usage dashboard

Token usage is recorded per model call, and there is a page for it:

```
https://your-app.up.railway.app/dashboard?token=<DASHBOARD_TOKEN>
```

It shows model calls, total tokens, **average prompt size**, and the cache share, plus a
per-day table splitting the average prompt into system / tools / messages. That split is
the useful part: it distinguishes "memory is growing" from "the tool schemas are simply
expensive" — measured, the tools were the dominant fixed cost, not memory.

The average prompt line is the one to watch over months.

Set `DASHBOARD_TOKEN` (or reuse `WEBHOOK_SECRET`) to unlock it. **With neither set the
route does not exist** — it returns 404 to everyone. That is deliberate: the page shows
your data on a domain anyone who knows the bot's name can resolve, so it fails closed
rather than defaulting to open. It also accepts `Authorization: Bearer <token>` for
scripting, sends `Cache-Control: no-store`, and asks not to be indexed.

`DASHBOARD_DAYS` changes the window (default 30, maximum 365).

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
2. Bot returns your most recent saved to-dos (up to 20), newest first, and your active reminders, including recurring schedules, with their next run times in your configured timezone
3. Each item has its own card with an ID, status, timestamps, and **Edit** / **Delete** buttons. To-dos also have **Complete** / **Reopen** buttons
4. **Edit** opens a pre-filled form. For reminders, edit the text or schedule (e.g. `every day at 22:00`, `every Monday at 09:00`, `every month on day 15 at 09:00`, or `tomorrow at 10:00`), then tap **Save**. To-dos use **Submit**. **Cancel** discards your edits
5. **Delete** asks for confirmation. Deleting a reminder stops its future runs and cancels pending occurrences and notifications; its delivery history is retained
6. Open `/pending` for delivered reminders awaiting Done, Snooze or Skip, and `/reminders` for quiet hours and follow-up preferences

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
│   │   ├── ai-client.ts        # Provider-neutral AIClient contract
│   │   ├── ai-provider.ts      # Picks a provider from configuration
│   │   ├── deepseek-provider.ts # DeepSeek implementation (default)
│   │   ├── gemini-provider.ts  # Gemini implementation (alternative)
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
│   │   ├── telegram-format.ts  # HTML escaping + Markdown→Telegram HTML
│   │   └── telegram-chunk.ts   # Splits messages to Telegram's 4096-char limit
│   ├── bot.ts                  # Bot setup, middleware, HTTP server, wiring
│   └── index.ts                # Entry point
├── scripts/
│   ├── webhook-manager.ts      # Telegram webhook CLI
│   ├── db-migrate.ts           # applies the schema via psql
│   ├── preflight.ts            # checks local config before deploying
│   └── verify-deploy.ts        # checks a live deployment
├── tests/                      # node:test suites (npm test)
├── docs/
│   ├── architecture.md         # system architecture, with diagrams
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

`npm test` blocks external HTTP requests and uses dummy credentials. The schema tests
run PostgreSQL locally through PGlite, including anonymous-access rejection and
repeatable migration checks; they do not connect to your Supabase project.

The assistant layer is built around interfaces (`AssistantStore`, `AIClient`,
`ToolRegistry`, `Clock`) with in-memory implementations, so the reminder scheduler, the
tool loop and the time maths are all tested without a live database, Telegram or a model
provider.

**Want to understand how it fits together?** [docs/architecture.md](docs/architecture.md)
explains the system with diagrams: the request path, the tool-calling loop and its
confirmation gate, how reminders survive restarts and daylight saving, the data model
and its Row Level Security posture, and the reasoning behind each decision.

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

### Docker (any host)

A `Dockerfile` is included, so the bot runs identically on Railway, Fly.io, or your own
machine. The build is multi-stage: devDependencies and TypeScript stay out of the
runtime image, and `.dockerignore` keeps `.env` out of the build context so credentials
never land in a layer.

```bash
docker build -t my-helper-bot .
docker run -d --name my-helper \
  --env-file .env.railway \
  --restart unless-stopped \
  -p 3000:3000 \
  my-helper-bot
```

`--restart unless-stopped` is what makes it survive crashes and reboots. The image
defines a `HEALTHCHECK` against `/health` (liveness only — a database outage must not
mark the container dead), and runs as the unprivileged `node` user.

To produce the Railway/Fly variable set from your local `.env`:

```bash
# .env.railway is gitignored — it holds real secrets
```

It deliberately excludes `DATABASE_URL`, which is only needed for `npm run db:migrate`
from your machine.

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
  reach Telegram. It does not query the database; `database.checked` is false. This
  keeps database outages from blocking the platform's liveness check.
- **`/ready`** — readiness. Returns 503 unless the database is genuinely writable
  (verified with a write probe, since RLS makes reads look fine when they are not).
  Use this one for UptimeRobot or any external monitor. Telegram and database probes
  have independent three-second deadlines and cancel stalled requests.
- `/ready` reports `unhealthy` (HTTP 503) if Telegram or any required table is unreachable
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

The bot requires these 14 Supabase tables:

- `user_data` - Stores user-specific key-value data
- `command_history` - Logs command usage for analytics
- `tasks` - Stores to-do tasks created from `/task`
- `prompts` - Stores prompt templates (`title`, `prompt`, `tags`, `image_file_id`) from `/prompt`
- `conversations` - Assistant conversation memory
- `facts` - Long-lived facts and preferences
- `reminders` - Scheduled reminders
- `reminder_occurrences` - Independent scheduled occurrences, action versions and notification leases
- `reminder_preferences` - Per-user quiet hours and explicit follow-up opt-in
- `reminder_followup_daily_usage` - Persistent per-user, local-day follow-up attempt budget
- `pending_actions` - Write-tool confirmations awaiting a tap
- `credentials` - Provider tokens (service_role only)
- `health_probes` - Single fixed row the `/ready` write probe upserts
- `token_usage` - Per-model-call token accounting

Run the SQL from `docs/database-schema.sql` in your Supabase SQL Editor to create these tables.
The readiness endpoint reports `unhealthy` if any of them is missing.

Or apply it from the command line (needs `psql` on PATH and `DATABASE_URL` in `.env`):

```bash
npm run db:migrate
```

The script applies the schema, then prints per-table status including which tables have
Row Level Security enabled, so you can confirm the migration took effect.

**Upgrading an existing deployment:** apply the updated `docs/database-schema.sql`
with `npm run db:migrate` or the Supabase SQL Editor **before deploying the new
application to Railway**. Actionable reminders add the three reminder tables above and
atomic database functions for materialization, leases, actions, settings and daily budgets.
Existing schedules and other data are retained; quiet hours and follow-ups start off.
The schema also includes the earlier `pending_actions.requested_at` migration, enables
RLS on the older task and prompt tables, and revokes client API grants on private tables.
Keep `SUPABASE_SERVICE_ROLE_KEY` configured. Webhook deployments also require a valid
`WEBHOOK_SECRET`; missing or invalid secrets now stop startup before registration.
The migration is repeatable and preserves existing rows.

Before deploying — or whenever something looks wrong — run the preflight check:

```bash
npm run preflight
```

It verifies every required variable, that the Telegram token works, that all fourteen tables
exist, that the service-role key can actually write to the RLS-protected tables, that the
anon key is correctly refused, that the configured model answers, and that reminders have
a delivery destination. It makes provider requests and temporary database write probes.

After deploying, check the live instance the same way:

```bash
npm run verify:deploy https://your-app.up.railway.app
```

It confirms both health endpoints answer correctly, that Telegram is pointed at *this*
deployment with the secret configured, and that webhook delivery has no errors. Reminder
delivery itself cannot be checked through the Bot API, so that stays a manual step.

**Row Level Security:** all fourteen tables have RLS enabled and server-only service-role
access. Anonymous and authenticated API grants are revoked. Set
`SUPABASE_SERVICE_ROLE_KEY` or persistence will fail; `/ready` reports database failures.

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
