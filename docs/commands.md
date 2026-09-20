# Commands Guide

This document explains all available commands and how to add new ones.

## 📋 Built-in Commands

| Command | Purpose |
| --- | --- |
| `/start` | Welcome message |
| `/help` | List commands (admin section only shown to admins) |
| `/ping` | Responsiveness + latency |
| `/task` | Task CRUD (`-create`, `-read`, `-update`, `-delete`) |
| `/tasks` | List tasks with completion toggles |
| `/prompt` | Create a prompt template |
| `/getprompt` | Search prompt templates |
| `/status` | Admin: health, uptime, memory |
| `/stats` | Admin: usage statistics |

Any text message that does not start with `/` is answered by the configured model (DeepSeek by default), except while a `/prompt` form is in progress.

---

### `/start`
**Description:** Welcome message for new users

**Usage:** `/start`

**Example:**
```
User: /start
Bot: 👋 Hello John! I'm your personal helper bot.
     I can help you with various tasks. Use /help to see available commands.
```

---

### `/help`
**Description:** Lists all available commands

**Usage:** `/help`

**Example:**
```
User: /help
Bot: 🤖 Available Commands:
     /start - Start the bot
     /help - Show this help message
     ...
```

---

### `/ping`
**Description:** Check bot responsiveness and latency

**Usage:** `/ping`

**Example:**
```
User: /ping
Bot: 🏓 Pong!
     ⚡ Response time: 142ms
```

---

### `/task`
**Description:** Create, read, update and delete to-do tasks

**Usage:**

| Command | Effect |
| --- | --- |
| `/task -create` | Opens the interactive form to create a task |
| `/task -read <id>` | Shows full details of one task |
| `/task -read all` | Lists all tasks (same as `/tasks`) |
| `/task -update <id>` | Opens the form pre-filled with that task |
| `/task -delete <id>` | Deletes that task |

Running `/task` with no flag returns the usage summary — the form is opened by `/task -create`, not by the bare command.

**Create flow:**
1. Bot shows a form with `Name`, `Description`, and `Submit` buttons
2. Tap `Name`, send the name text
3. Tap `Description`, send the description text
4. Tap `Submit` to persist the task to the database

**Example:**
```
User: /task -create
Bot: 📝 New Task Form
     Name: (not set)
     Description: (not set)
     [Name] [Description]
     [Submit]

User: /task -read 12
Bot: 📖 Task Details (ID: 12)

     Name: Buy groceries
     Description: Milk, eggs, bread
     Status: ⬜ Pending
     Created: 3/2/2026, 9:14:00 AM
```

Task names and descriptions are HTML-escaped before being echoed back, so characters like `<`, `&` and `*` cannot break the message or inject formatting.

---

### `/tasks`
**Description:** List your saved tasks

**Usage:** `/tasks`

**Behavior:**
1. Fetches your tasks from the `tasks` table
2. Shows up to 20 tasks, newest first
3. Displays status, name, description, and created date
4. The `[1]`, `[2]`, … buttons toggle a task between completed (✅) and uncompleted (⬜)

**Example:**
```
User: /tasks
Bot: 📝 Your Tasks (2)
     1. ⬜ Buy groceries
        Milk, eggs, bread
        Created: 2/21/2026
```

---

### `/prompt`
**Description:** Create a reusable prompt template with tags and an image

**Usage:** `/prompt`

**Flow:**
1. Send the **title**
2. Send the **prompt text**
3. Send comma-separated **tags** (or `skip`)
4. Send an **image** — the highest resolution Telegram offers is stored, as a `file_id`

Sending text instead of an image at the last step cancels the draft, so a half-finished prompt never swallows your subsequent messages. Running `/prompt` again discards any existing draft.

---

### `/getprompt`
**Description:** Search your saved prompt templates

**Usage:**
```
/getprompt -title <text>
/getprompt -tag <tag1,tag2>
/getprompt -title <text> -tag <tag1,tag2>
```

**Behavior:**
1. Title matching is a case-insensitive substring match (`ilike`)
2. Tag matching requires **all** supplied tags (PostgreSQL array containment)
3. Each result is sent as a photo with its title, tags and prompt text as the caption
4. `⬅️ Previous` / `Next ➡️` buttons page through multiple results

At least one of `-title` or `-tag` is required. Values may contain hyphens (`/getprompt -title my-prompt` works).

---

## 🔧 Adding New Commands

### Basic Command

1. Open `src/commands/index.ts`
2. Create a handler function:

```typescript
async function myCommandHandler(ctx: Context) {
  await ctx.reply('Hello! This is my custom command.');
}
```

3. Register it in `registerCommands()`:

```typescript
export function registerCommands(bot: Telegraf): void {
  // ... existing commands
  bot.command('mycommand', myCommandHandler);
}
```

4. Update help text:

```typescript
async function helpCommand(ctx: Context) {
  const helpText = `
🤖 *Available Commands:*
...
/mycommand - Description of what it does
  `;
  await ctx.reply(helpText, { parse_mode: 'Markdown' });
}
```

---

### Command with Arguments

```typescript
async function greetCommand(ctx: Context) {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const args = text.split(' ').slice(1); // Remove command name

  if (args.length === 0) {
    await ctx.reply('Usage: /greet <name>');
    return;
  }

  const name = args.join(' ');
  await ctx.reply(`Hello, ${name}! 👋`);
}
```

---

### Command with Database Access

```typescript
async function countCommand(ctx: Context) {
  const { db } = await import('../services/database.js');
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Could not identify user');
    return;
  }

  try {
    const userData = await db.getUserData(userId);
    const count = userData?.data?.count || 0;
    const newCount = count + 1;

    await db.saveUserData(userId, { ...userData?.data, count: newCount });
    await ctx.reply(`You've used this command ${newCount} times!`);
  } catch (error) {
    console.error('Count command error:', error);
    await ctx.reply('❌ Failed to process request');
  }
}
```

---

### Command with Inline Keyboard

```typescript
import { Markup } from 'telegraf';

async function menuCommand(ctx: Context) {
  await ctx.reply(
    'Choose an option:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Option 1', 'opt1')],
      [Markup.button.callback('Option 2', 'opt2')],
      [Markup.button.callback('Cancel', 'cancel')]
    ])
  );
}

// Handle button callbacks
bot.action('opt1', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('You selected Option 1');
});
```

---

## 🎯 Command Ideas

Here are some ideas for commands you might want to add:

### Utility Commands
- `/remind <time> <message>` - Set reminders
- `/note <text>` - Quick note taking
- `/list` - List all saved keys
- `/delete <key>` - Delete saved data
- `/clear` - Clear all your data

### Information Commands
- `/weather <city>` - Get weather info (requires API)
- `/news` - Latest news headlines (requires API)
- `/define <word>` - Dictionary lookup
- `/translate <text>` - Translation

### Fun Commands
- `/joke` - Random joke
- `/quote` - Inspirational quote
- `/fact` - Random fact
- `/roll <dice>` - Roll dice (e.g., 2d6)

### Productivity Commands
- `/todo add <task>` - Add to-do item
- `/todo list` - List tasks
- `/todo done <id>` - Mark task complete
- `/timer <minutes>` - Set countdown timer
- `/calculate <expression>` - Calculator

### Personal Assistant
- `/expense <amount> <category>` - Track expenses
- `/budget` - View budget summary
- `/habit <name>` - Track daily habits
- `/journal <entry>` - Daily journal

---

## 🔐 Command Security

### User Verification

Always verify the user:

```typescript
async function secureCommand(ctx: Context) {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Authentication failed');
    return;
  }

  // Your command logic
}
```

### Admin-Only Commands

```typescript
const ADMIN_USER_IDS = [123456789]; // Your Telegram user ID

async function adminCommand(ctx: Context) {
  const userId = ctx.from?.id;

  if (!userId || !ADMIN_USER_IDS.includes(userId)) {
    await ctx.reply('❌ Unauthorized');
    return;
  }

  // Admin-only logic
}
```

---

## 📊 Command Analytics

All commands are automatically logged to `command_history` table. View usage:

```sql
-- Most used commands
SELECT command, COUNT(*) as usage_count
FROM command_history
GROUP BY command
ORDER BY usage_count DESC;

-- Commands by user
SELECT user_id, command, COUNT(*) as usage_count
FROM command_history
GROUP BY user_id, command;

-- Recent command activity
SELECT *
FROM command_history
ORDER BY created_at DESC
LIMIT 20;
```

---

## 🎨 Response Formatting

### Markdown Support

```typescript
await ctx.reply(
  '*Bold text*\n' +
  '_Italic text_\n' +
  '`Code text`\n' +
  '[Link](https://example.com)',
  { parse_mode: 'Markdown' }
);
```

### HTML Support

```typescript
await ctx.reply(
  '<b>Bold</b>\n' +
  '<i>Italic</i>\n' +
  '<code>Code</code>\n' +
  '<a href="https://example.com">Link</a>',
  { parse_mode: 'HTML' }
);
```

### Emojis

Use emojis to make responses more engaging:
- ✅ Success
- ❌ Error
- ⚠️ Warning
- ℹ️ Info
- 🔄 Loading
- 📝 Note
- 🎉 Celebration

---

## 🧪 Testing Commands

Test commands manually:

```bash
# Start bot in development mode
npm run dev

# Open Telegram and message your bot
# Try each command
```

Add automated tests (optional):

```typescript
// tests/commands.test.ts
import { Telegraf } from 'telegraf';

describe('Commands', () => {
  it('should respond to /ping', async () => {
    // Test implementation
  });
});
```

---

## 📚 Further Reading

- [Telegraf Documentation](https://telegraf.js.org/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Markdown Formatting](https://core.telegram.org/bots/api#markdown-style)

---

**Happy commanding! 🚀**
