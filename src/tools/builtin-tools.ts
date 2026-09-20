import { ToolRegistry, type ToolDefinition } from './registry.js';
import { createWeatherTools } from './weather-tools.js';
import { formatLocal, parseNaturalTime, WEEKDAY_NAMES } from '../services/reminder-time.js';

/** Renders a call for the confirmation prompt. */
export function summariseCall(tool: ToolDefinition, args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return tool.name;
  }
  return `${tool.name}(${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')})`;
}

const currentTime: ToolDefinition = {
  name: 'current_time',
  description:
    "Get the user's current local date, time and timezone. The system prompt already states the current time, but call this whenever you are about to say what time it is, resolve a relative request like 'in 10 minutes', or judge whether something is in the past.",
  kind: 'read',
  parameters: { type: 'object', properties: {} },
  async execute(_args, context) {
    return `Local time: ${formatLocal(context.now, context.timezone)} (${context.timezone}), ISO: ${context.now.toISOString()}`;
  },
};

const saveFact: ToolDefinition = {
  name: 'save_fact',
  description:
    "Remember a durable fact or preference about the user. Use short lowercase keys like 'home_city' or 'diet'. " +
    "Set tier to 'core' only for things that should shape your behaviour unprompted (diet, allergies, home city, " +
    "dislikes): core facts are always in your context, so keep them few. Everything else — passwords, codes, " +
    'details you would only look up on request — stays \'reference\' and costs no context.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: "Short identifier, e.g. 'home_city'" },
      value: { type: 'string', description: 'The value to remember, e.g. "Singapore"' },
      tier: {
        type: 'string',
        description: "'core' (always in context) or 'reference' (looked up on demand). Defaults to reference.",
        enum: ['core', 'reference'],
      },
    },
    required: ['key', 'value'],
  },
  async execute(args, context) {
    const key = String(args.key);
    const value = String(args.value);
    const tier = args.tier === 'core' ? 'core' : 'reference';
    await context.store.saveFact(context.userId, key, value, tier);
    const note = tier === 'core' ? ' It is now always in my context.' : '';
    return `Saved fact "${key}" = "${value}" (${tier}).${note}`;
  },
};

const listFacts: ToolDefinition = {
  name: 'list_facts',
  description:
    'List everything currently remembered about the user, including the core facts already in your context.',
  kind: 'read',
  parameters: { type: 'object', properties: {} },
  async execute(_args, context) {
    const facts = await context.store.listFacts(context.userId);
    if (facts.length === 0) {
      return 'No facts stored yet.';
    }
    return facts
      .map((fact) => `${fact.key}${fact.tier === 'core' ? ' [core]' : ''}: ${fact.value}`)
      .join('\n');
  },
};

const createReminder: ToolDefinition = {
  name: 'create_reminder',
  description:
    'Schedule a reminder. Provide when_text as the user phrased it (e.g. "in 30 minutes", "tomorrow at 07:30", "every day at 09:00").',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to remind the user about' },
      when_text: { type: 'string', description: 'When, as natural language' },
    },
    required: ['text', 'when_text'],
  },
  async execute(args, context) {
    const text = String(args.text);
    const whenText = String(args.when_text);
    const parsed = parseNaturalTime(whenText, context.now, context.timezone);

    if (!parsed) {
      return `I could not understand the time "${whenText}". Nothing was scheduled.`;
    }

    const recurrence = parsed.recurrence;
    const reminder = await context.store.createReminder({
      userId: context.userId,
      text,
      nextRunAt: parsed.date.toISOString(),
      frequency: recurrence?.frequency ?? 'once',
      timeOfDay: recurrence?.timeOfDay ?? null,
      dayOfWeek: recurrence?.dayOfWeek ?? null,
      dayOfMonth: recurrence?.dayOfMonth ?? null,
    });

    const whenLabel = formatLocal(parsed.date, context.timezone);
    if (recurrence) {
      const cadence =
        recurrence.frequency === 'daily'
          ? 'every day'
          : `every ${WEEKDAY_NAMES[recurrence.dayOfWeek ?? 1]}`;
      return `Reminder #${reminder.id} set for ${cadence} at ${recurrence.timeOfDay} (next: ${whenLabel}).`;
    }

    return `Reminder #${reminder.id} set for ${whenLabel}.`;
  },
};

const listReminders: ToolDefinition = {
  name: 'list_reminders',
  description: 'List the reminders that are currently scheduled.',
  kind: 'read',
  parameters: { type: 'object', properties: {} },
  async execute(_args, context) {
    const reminders = await context.store.listReminders(context.userId);
    if (reminders.length === 0) {
      return 'No reminders scheduled.';
    }
    return reminders
      .map((reminder) => {
        const when = formatLocal(new Date(reminder.nextRunAt), context.timezone);
        const cadence = reminder.frequency === 'once' ? '' : ` (${reminder.frequency})`;
        return `#${reminder.id} ${reminder.text} — ${when}${cadence}`;
      })
      .join('\n');
  },
};

const cancelReminder: ToolDefinition = {
  name: 'cancel_reminder',
  description: 'Cancel a scheduled reminder by its id.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      reminder_id: { type: 'integer', description: 'The reminder id shown by list_reminders', minimum: 1 },
    },
    required: ['reminder_id'],
  },
  async execute(args, context) {
    const id = Number(args.reminder_id);
    const cancelled = await context.store.cancelReminder(id, context.userId);
    if (!cancelled) {
      return `No active reminder with id ${id}.`;
    }
    return `Reminder #${id} cancelled.`;
  },
};

const listTodos: ToolDefinition = {
  name: 'list_todos',
  description: "List the user's open to-do tasks.",
  kind: 'read',
  parameters: { type: 'object', properties: {} },
  async execute(_args, context) {
    const { db } = await import('../services/database.js');
    const tasks = await db.getTasksByUser(context.userId, 20);
    if (tasks.length === 0) {
      return 'No tasks.';
    }
    return tasks
      .map((task) => `${task.completed ? '[x]' : '[ ]'} #${task.id} ${task.name}`)
      .join('\n');
  },
};

const addTodo: ToolDefinition = {
  name: 'add_todo',
  description: 'Create a new to-do task for the user.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short task title' },
      description: { type: 'string', description: 'Optional extra detail' },
    },
    required: ['name'],
  },
  async execute(args, context) {
    const { db } = await import('../services/database.js');
    const name = String(args.name);
    const description = args.description ? String(args.description) : name;
    await db.createTask(context.userId, name, description);
    return `Added task "${name}".`;
  },
};

/**
 * The default tool set. Every write tool here is gated behind a confirmation,
 * so this list is also the definition of what the assistant may do to the
 * user's data.
 *
 * `weatherTools` is injectable so tests can supply a fake WeatherService
 * instead of reaching Open-Meteo.
 */
export function createDefaultToolRegistry(weatherTools: ToolDefinition[] = createWeatherTools()): ToolRegistry {
  return new ToolRegistry([
    currentTime,
    saveFact,
    listFacts,
    createReminder,
    listReminders,
    cancelReminder,
    listTodos,
    addTodo,
    ...weatherTools,
  ]);
}
