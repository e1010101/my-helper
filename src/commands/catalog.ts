/**
 * The command catalog: one source of truth for three consumers.
 *
 *   1. Telegram's command menu, via setMyCommands — what appears when you type `/`
 *   2. The /help text
 *   3. Documentation
 *
 * Previously the help text was hand-written and the registrations lived in two
 * files, so any of the three could drift from the others without anything
 * failing. Descriptions here are the single string; /help composes them with its
 * own grouping.
 */

export interface CommandDefinition {
  name: string;
  /** Short description, as shown in Telegram's command menu. */
  description: string;
  /**
   * Extra lines for /help only. The command menu is a narrow autocomplete
   * popup, so flags and arguments belong here rather than in `description`.
   */
  usage?: string[];
  /** Admin-only commands are registered separately in the menu, per chat. */
  admin?: boolean;
}

/**
 * Telegram rejects descriptions outside 3-256 characters, so keep these terse —
 * they appear in a narrow autocomplete popup, not in prose.
 */
export const COMMANDS: CommandDefinition[] = [
  { name: 'start', description: 'Welcome message' },
  { name: 'help', description: 'List every command' },
  { name: 'ping', description: 'Check the bot is responsive' },
  {
    name: 'task',
    description: 'Create, view, edit or delete a todo',
    usage: [
      '  -create : Create a task',
      '  -read <id> : View a task (all to list every task)',
      '  -update <id> : Edit a task',
      '  -delete <id> : Delete a task',
    ],
  },
  { name: 'tasks', description: 'List your todos' },
  { name: 'prompt', description: 'Save a prompt template' },
  {
    name: 'getprompt',
    description: 'Search saved prompts',
    usage: [
      '  -title <text> : Search titles',
      '  -tag <tag1,tag2> : Search tags',
    ],
  },
  { name: 'memory', description: 'See what the assistant remembers' },
  { name: 'forget', description: 'Clear conversation history' },
  { name: 'status', description: 'Health, uptime and memory usage', admin: true },
  { name: 'stats', description: 'Usage statistics', admin: true },
];

export function commandsFor(includeAdmin: boolean): CommandDefinition[] {
  return includeAdmin ? COMMANDS : COMMANDS.filter((command) => !command.admin);
}

/** The shape Telegram's setMyCommands expects. */
export function toBotCommands(includeAdmin: boolean): { command: string; description: string }[] {
  return commandsFor(includeAdmin).map(({ name, description }) => ({
    command: name,
    description,
  }));
}

/**
 * Renders the /help body. Kept here so the menu and the help text cannot
 * disagree about what exists.
 */
export function renderHelpText(includeAdmin: boolean): string {
  const section = (commands: CommandDefinition[]) =>
    commands
      .map((command) => {
        const lines = [`/${command.name} - ${command.description}`];
        if (command.usage) {
          lines.push(...command.usage);
        }
        return lines.join('\n');
      })
      .join('\n');

  let text = `🤖 *Available Commands:*\n\n${section(commandsFor(false))}\n`;

  if (includeAdmin) {
    const admin = commandsFor(true).filter((command) => command.admin);
    if (admin.length > 0) {
      text += `\n*Admin Commands:*\n${section(admin)}\n`;
    }
  }

  text += '\n_Just talk to me in plain text for anything else — I can set reminders,'
    + ' remember facts, check the weather and manage tasks._';

  return text;
}
