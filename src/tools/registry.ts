import type { AssistantStore } from '../services/assistant-store.js';

/**
 * Standard JSON Schema describing a tool's parameters, sent to the model via
 * `parametersJsonSchema` (which accepts lowercase JSON Schema types, unlike the
 * OpenAPI-flavoured `parameters` field).
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
}

export interface ToolPropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
}

export interface ToolContext {
  userId: number;
  store: AssistantStore;
  timezone: string;
  now: Date;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  /**
   * Read tools run immediately. Write tools are surfaced to the user for
   * confirmation before they touch anything.
   */
  kind: 'read' | 'write';
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/** Raised when a tool is called with arguments that do not fit its schema. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export interface ValidatedCall {
  tool: ToolDefinition;
  args: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  listByKind(kind: ToolDefinition['kind']): ToolDefinition[] {
    return this.list().filter((tool) => tool.kind === kind);
  }

  /** Gemini function declarations for every registered tool. */
  toFunctionDeclarations(): { name: string; description: string; parametersJsonSchema: ToolParameterSchema }[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    }));
  }

  /**
   * Resolves a model-requested call to a tool and its validated arguments.
   * Unknown tools and malformed arguments are returned as errors rather than
   * thrown, so the model can be told what it did wrong and try again.
   */
  resolve(name: string, rawArgs: unknown): { call?: ValidatedCall; error?: string } {
    const tool = this.tools.get(name);
    if (!tool) {
      return { error: `Unknown tool "${name}".` };
    }

    const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};

    try {
      return { call: { tool, args: validateArguments(tool, args) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid arguments';
      return { error: message };
    }
  }

  async execute(call: ValidatedCall, context: ToolContext): Promise<string> {
    return await call.tool.execute(call.args, context);
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validates arguments against the declared parameter schema. This is the only
 * gate between model output and side effects, so it is strict: unknown keys are
 * rejected to stop the model from inventing parameters a tool silently ignores.
 */
export function validateArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>
): Record<string, unknown> {
  const properties = tool.parameters.properties ?? {};
  const required = tool.parameters.required ?? [];

  for (const key of Object.keys(args)) {
    if (!(key in properties)) {
      throw new ToolArgumentError(
        `Unexpected parameter "${key}" for tool "${tool.name}". Allowed: ${Object.keys(properties).join(', ') || 'none'}.`
      );
    }
  }

  const validated: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];

    if (value === undefined || value === null || value === '') {
      if (required.includes(key)) {
        throw new ToolArgumentError(`Missing required parameter "${key}" for tool "${tool.name}".`);
      }
      continue;
    }

    if (schema.type === 'string' && typeof value !== 'string') {
      throw new ToolArgumentError(`Parameter "${key}" must be a string, got ${describeType(value)}.`);
    }

    if (schema.type === 'number' || schema.type === 'integer') {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) {
        throw new ToolArgumentError(`Parameter "${key}" must be a number, got ${describeType(value)}.`);
      }
      if (schema.type === 'integer' && !Number.isInteger(numeric)) {
        throw new ToolArgumentError(`Parameter "${key}" must be a whole number.`);
      }
      if (schema.minimum !== undefined && numeric < schema.minimum) {
        throw new ToolArgumentError(`Parameter "${key}" must be at least ${schema.minimum}.`);
      }
      if (schema.maximum !== undefined && numeric > schema.maximum) {
        throw new ToolArgumentError(`Parameter "${key}" must be at most ${schema.maximum}.`);
      }
      validated[key] = numeric;
      continue;
    }

    if (schema.type === 'boolean' && typeof value !== 'boolean') {
      throw new ToolArgumentError(`Parameter "${key}" must be a boolean.`);
    }

    if (schema.enum && !schema.enum.some((allowed) => allowed === value || String(allowed) === String(value))) {
      throw new ToolArgumentError(
        `Parameter "${key}" must be one of: ${schema.enum.map(String).join(', ')}.`
      );
    }

    validated[key] = value;
  }

  return validated;
}
