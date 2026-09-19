# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A powerful, extensible Telegram bot built with TypeScript, designed for personal use. The bot uses the Telegraf framework for Telegram integration, Supabase for PostgreSQL storage, and a configurable LLM provider for conversational replies.

**Tech Stack:**
- **Runtime:** Node.js (v20+) with TypeScript (ESM — imports use `.js` extensions)
- **Bot Framework:** Telegraf v4
- **Database:** Supabase (PostgreSQL)
- **AI:** DeepSeek (`deepseek-chat`) by default; Google Gemini also supported
- **Hosting:** Railway.app (recommended) or any Node.js hosting platform
- **Development:** tsx for fast TypeScript execution with watch mode

## Development Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and configure:
   - `TELEGRAM_BOT_TOKEN`: Get from @BotFather on Telegram
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`: From your Supabase project settings
   - `SUPABASE_SERVICE_ROLE_KEY`: **Required** for assistant memory, facts, reminders
     and confirmations — those tables have RLS enabled and only answer this key
   - `DEEPSEEK_API_KEY`: From platform.deepseek.com. `AI_PROVIDER` picks between
     providers; with only one key set it is inferred, and having both keys set
     without `AI_PROVIDER` is a startup error rather than a silent coin flip
   - `GEMINI_API_KEY`: Optional alternative provider (`AI_PROVIDER=gemini`)
   - `ADMIN_USER_ID`: Your Telegram user ID (comma-separated list is supported; unset
     means no admins, and reminders have no delivery destination)
   - `TIMEZONE`: IANA name (e.g. `Asia/Singapore`) used for reminders and
     "today"/"tomorrow" parsing; defaults to the host timezone
3. Set up Supabase tables (see Database Schema section below)
4. Run in development mode: `npm run dev`

## Common Commands

- `npm run dev` - Start bot in development mode with hot reload
- `npm run build` - Compile TypeScript to JavaScript (emits to `dist/`)
- `npm start` - Run compiled bot (production)
- `npm run lint` - Run ESLint over `src`, `scripts` and `tests`
- `npm run type-check` - Type check everything without emitting (`tsconfig.check.json`)
- `npm test` - Run the `node:test` suites under `tests/`
- `npm run db:migrate` - Apply `docs/database-schema.sql` via `psql` (needs `DATABASE_URL`)
- `npm run preflight` - Verify variables, Telegram, Supabase (incl. RLS) and the model
- `npm run webhook:info|delete|set` - Inspect or change the Telegram webhook

## Architecture

### Project Structure
```
src/
├── config/
│   └── env.ts              # Lazy environment access (reading config validates it)
├── services/
│   ├── database.ts         # Supabase client, task/prompt operations
│   ├── assistant-store.ts  # AssistantStore interface + Clock
│   ├── supabase-assistant-store.ts  # Postgres memory/facts/reminders/confirmations
│   ├── in-memory-assistant-store.ts # In-memory store for tests and fallbacks
│   ├── assistant.ts        # Conversation loop, tool dispatch, confirmations
│   ├── ai-client.ts        # Provider-neutral AIClient/AgentMessage contract
│   ├── ai-provider.ts      # Picks the provider from configuration
│   ├── deepseek-provider.ts # DeepSeek (OpenAI-compatible) implementation
│   ├── gemini-provider.ts  # Gemini implementation
│   ├── reminder-time.ts    # Timezone maths, recurrence, NL time parsing
│   ├── reminder-scheduler.ts # Polls due reminders and delivers them
│   ├── health.ts           # Health snapshot for /health and /status
│   └── logger.ts           # Leveled console logger
├── tools/
│   ├── registry.ts         # Tool registry, classification, arg validation
│   └── builtin-tools.ts    # Tools the model may call
├── commands/
│   ├── index.ts            # Core commands, task form, admin commands
│   ├── assistant-commands.ts # /forget, /memory
│   ├── prompt.ts           # /prompt multi-step creation flow
│   └── getprompt.ts        # /getprompt search and pagination
├── types/
│   └── assistant.ts        # Shared assistant data shapes
├── utils/
│   └── telegram-format.ts  # HTML escaping + Markdown→Telegram HTML
├── bot.ts                  # Bot initialization, middleware, HTTP server, wiring
└── index.ts                # Application entry point
```

### Key Components

**Bot Initialization** ([src/bot.ts](src/bot.ts))
- Sets up the Telegraf bot instance with `webhookReply: false`
- Configures middleware for logging and command tracking
- Wires the assistant: `SupabaseAssistantStore` → `AssistantService` (with the default
  tool registry and the configured `AIClient`) → `ReminderScheduler`
- Routes non-command text to the assistant (skipped while a `/prompt` draft is active)
- Serves `/health` (liveness), `/ready` (readiness, including a database write probe)
  and `/` plus `/webhook` from one HTTP server in both modes. Keep the two health
  endpoints distinct: a database outage must not fail Railway's healthcheck, because
  restarting cannot repair a database and a crash loop would take the bot down
  entirely instead of degrading.
- Binds explicitly to `0.0.0.0` and prefers the platform-injected `PORT`
- Starts the reminder scheduler only when `ADMIN_USER_ID` gives it a destination
- Handles graceful shutdown on SIGINT/SIGTERM (scheduler, then HTTP server, then bot)

**Assistant Loop** ([src/services/assistant.ts](src/services/assistant.ts))
- Loads conversation history from the store, appends the new user message, then runs at
  most `maxToolIterations` model passes
- `kind: 'read'` tools execute inline; their output is fed back as a function response
- The first `kind: 'write'` tool **stops the loop** and returns a `confirmation`, which
  bot.ts renders as Confirm/Cancel buttons. Nothing is written until a tap
- Confirmations are persisted with the originating model turn, expire after 10 minutes,
  and are rejected if approved by a different user
- Confirmed tools execute against the *original* request time, so "in 5 minutes" does not
  drift by however long the confirmation took

**Tool Registry** ([src/tools/registry.ts](src/tools/registry.ts))
- A tool declares `parameters` as standard JSON Schema, sent via
  `parametersJsonSchema` (the OpenAPI-flavoured `parameters` field wants UPPERCASE types)
- `validateArguments` is the only gate between model output and side effects: it rejects
  unknown keys, enforces required fields, coerces numerics and checks enums/bounds
- Adding a capability means adding a `ToolDefinition` to `builtin-tools.ts`; mark
  anything that mutates state as `kind: 'write'` so it inherits the confirmation flow

**Reminders** ([src/services/reminder-time.ts](src/services/reminder-time.ts), [src/services/reminder-scheduler.ts](src/services/reminder-scheduler.ts))
- Stored as an absolute `next_run_at` plus wall-clock columns (`time_of_day`,
  `day_of_week`) so "every Monday 09:00" survives DST changes
- `nextOccurrence` walks local days and resolves each candidate through
  `instantFromWallClock` rather than adding fixed 24h steps
- The scheduler polls every 30s; delivery is at-least-once (duplicate beats silence), and
  a reminder recorded as sent is never sent twice for the same occurrence
- Reminders missed while offline are delivered flagged `late`

**Database Service** ([src/services/database.ts](src/services/database.ts))
- Singleton Supabase client; uses `SUPABASE_SERVICE_ROLE_KEY` when present
- Task and prompt CRUD helpers; `getTask` returns `null` (not an error) when the row is absent

### Testing

`npm test` runs `node:test` suites in `tests/`. Everything time-, model- or
database-dependent goes through an interface (`AssistantStore`, `AIClient`,
`ToolRegistry`, `Clock`) with an in-memory or scripted implementation, so tests need no
credentials or network. Keep it that way when adding features: if a new capability is
hard to test, that is a sign it should take its dependency as a parameter.

The model provider is behind `AIClient` ([src/services/ai-client.ts](src/services/ai-client.ts)),
which speaks a neutral `AgentMessage` conversation; each provider translates to and from
its own wire format. `DeepSeekProvider.toChatMessages` is exported specifically so the
translation can be asserted without a network call, and `DeepSeekProvider` accepts a
`fetchImpl` for the same reason.

### Message Formatting

Telegram rejects a whole message with a 400 "can't parse entities" error if
user-supplied text contains parse-mode characters. Two rules follow:

1. **Never interpolate raw user text** into a message sent with a `parse_mode`.
   Wrap it in `escapeHtml()` from [src/utils/telegram-format.ts](src/utils/telegram-format.ts)
   and send with `parse_mode: 'HTML'`.
2. Models return standard Markdown, which is **not** Telegram's dialect
   (`**bold**`, headings and fenced code blocks do not render). Pass AI output
   through `markdownToTelegramHtml()` before replying.

Prefer `parse_mode: 'HTML'` for new code; the remaining legacy `Markdown` usages are
static strings with no interpolation.

### Database Schema

Required Supabase tables (full DDL in [docs/database-schema.sql](docs/database-schema.sql)):
`user_data`, `command_history`, `tasks`, `prompts`, `conversations`, `facts`,
`reminders`, `pending_actions`, `credentials`, `health_probes`. The health check queries
all of them, so a missing table makes `/health` report `unhealthy`.

`conversations`, `facts`, `reminders`, `pending_actions`, `credentials` and
`health_probes` have Row Level Security enabled with only a `service_role` policy. **The
bot must run with `SUPABASE_SERVICE_ROLE_KEY`**; never ship that key to a client.

Two important consequences:

- Reading an RLS-protected table with the wrong key does **not** error, it returns zero
  rows. That is why the readiness probe performs a write rather than a SELECT when
  deciding whether the database is usable — and why it writes to `health_probes`, a
  fixed-key single row, instead of `conversations`: a monitor polling every 30s must
  never be able to accumulate rows or inflate a sequence.
- The policy block in the schema is skipped when `service_role` does not exist, so the
  file also applies cleanly to a plain Postgres instance (useful for testing).

`docs/database-schema.sql` is applied with `npm run db:migrate` (psql; PostgREST cannot
execute DDL such as `DO` blocks or `ENABLE ROW LEVEL SECURITY`). It is written to be
re-runnable.

### Adding New Commands

1. Create a handler function in [src/commands/index.ts](src/commands/index.ts)
   (or a new file under `src/commands/` for a larger feature)
2. Register it in `registerCommands()`
3. Add it to the help text in `helpCommand()`
4. Handlers receive a Telegraf `Context` object with user info and message data

### Deployment

**Railway.app (Recommended):**
1. Connect the GitHub repository to Railway
2. Add environment variables in the Railway dashboard (including `DEEPSEEK_API_KEY`)
3. Railway auto-detects Node.js and runs `npm start`
4. For webhook mode: set `WEBHOOK_DOMAIN` to your Railway domain and `WEBHOOK_SECRET`
   to a random `A-Za-z0-9_-` string

**Ports:** Railway injects `PORT`; the bot prefers it over `WEBHOOK_PORT`
(default 3000). Do not hardcode a port.

**Polling vs Webhook:**
- **Polling** (default): the bot continuously checks for updates. Simpler for development.
- **Webhook**: Telegram pushes updates to your server. More efficient for production.
  Enabled by setting `WEBHOOK_DOMAIN`; `WEBHOOK_SECRET` makes Telegram sign every
  request with the `X-Telegram-Bot-Api-Secret-Token` header.
