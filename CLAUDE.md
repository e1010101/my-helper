# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A powerful, extensible Telegram bot built with TypeScript, designed for personal use. The bot uses Telegraf framework for Telegram integration and Supabase for PostgreSQL database storage.

**Tech Stack:**
- **Runtime:** Node.js (v18+) with TypeScript
- **Bot Framework:** Telegraf v4
- **Database:** Supabase (PostgreSQL)
- **Hosting:** Railway.app (recommended) or any Node.js hosting platform
- **Development:** tsx for fast TypeScript execution with watch mode

## Development Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and configure:
   - `TELEGRAM_BOT_TOKEN`: Get from @BotFather on Telegram
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY`: From your Supabase project settings
3. Set up Supabase tables (see Database Schema section below)
4. Run in development mode: `npm run dev`

## Common Commands

- `npm run dev` - Start bot in development mode with hot reload
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run compiled bot (production)
- `npm run lint` - Run ESLint
- `npm run type-check` - Type check without emitting files

## Architecture

### Project Structure
```
src/
├── config/
│   └── env.ts          # Environment configuration and validation
├── services/
│   └── database.ts     # Supabase client and database operations
├── commands/
│   └── index.ts        # Bot command handlers (start, help, save, get, etc.)
├── bot.ts              # Bot initialization, middleware, error handling
└── index.ts            # Application entry point
```

### Key Components

**Bot Initialization** ([src/bot.ts](src/bot.ts))
- Sets up Telegraf bot instance
- Configures middleware for logging and command tracking
- Registers command handlers
- Supports both polling (dev) and webhook (production) modes
- Handles graceful shutdown on SIGINT/SIGTERM

**Command System** ([src/commands/index.ts](src/commands/index.ts))
- Modular command registration
- Built-in commands: `/start`, `/help`, `/ping`, `/task`, plus admin commands `/status`, `/stats`
- Commands automatically log usage to database
- Add new commands by creating handler functions and registering in `registerCommands()`

**Database Service** ([src/services/database.ts](src/services/database.ts))
- Singleton Supabase client
- Helper methods for common operations (saveUserData, getUserData, logCommand)
- Error handling and logging

### Database Schema

Required Supabase tables:

```sql
-- User data storage (key-value per user)
CREATE TABLE user_data (
  user_id BIGINT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Command usage history
CREATE TABLE command_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  command TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for better query performance
CREATE INDEX idx_command_history_user_id ON command_history(user_id);
CREATE INDEX idx_command_history_created_at ON command_history(created_at);
```

### Adding New Commands

1. Create handler function in [src/commands/index.ts](src/commands/index.ts)
2. Register in `registerCommands()` function
3. Add to help text in `helpCommand()`
4. Handler receives Telegraf `Context` object with user info and message data

### Deployment

**Railway.app (Recommended):**
1. Connect GitHub repository to Railway
2. Add environment variables in Railway dashboard
3. Railway auto-detects Node.js and runs `npm start`
4. For webhook mode: Set `WEBHOOK_DOMAIN` to your Railway domain

**Polling vs Webhook:**
- **Polling** (default): Bot continuously checks for updates. Simpler for development.
- **Webhook**: Telegram sends updates to your server. More efficient for production. Enable by setting `WEBHOOK_DOMAIN` and `WEBHOOK_PORT` in `.env`.
