import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: { message?: string };
};

type JsonRpcNotification = {
  method: string;
  params?: any;
};

type QueueEntry = {
  timestamp: number;
  requestId?: string;
  questionId?: string;
  choice?: string;
  action?: string;
  workspace?: string;
};

type ToastOption = {
  label: string;
  value: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || os.tmpdir();
const STATE_DIR = path.join(LOCAL_APP_DATA, 'CodexNotify');
const QUEUE_PATH = path.join(STATE_DIR, 'responses.jsonl');
const TOAST_SCRIPT = path.resolve('scripts', 'codex-notify-toast.ps1');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen - 1)}...`;
}

function normalizeId(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

type CliArgs = {
  daemon: boolean;
  prompt: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  npm run codex:notify -- "your prompt"');
    console.log('  npm run codex:notify -- --daemon [initial prompt]');
    process.exit(0);
  }

  const daemon = args.includes('--daemon');
  const cleaned = args.filter((arg) => arg !== '--daemon');
  return {
    daemon,
    prompt: cleaned.join(' ').trim(),
  };
}

function ensureState(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(QUEUE_PATH)) {
    fs.writeFileSync(QUEUE_PATH, '', 'utf8');
  }
}

async function promptInTerminal(question: string, options: string[] | null): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptText = options && options.length > 0
    ? `${question}\n${options.map((opt, idx) => `${idx + 1}. ${opt}`).join('\n')}\nChoose option #: `
    : `${question}\nAnswer: `;

  const answer = await new Promise<string>((resolve) => {
    rl.question(promptText, (value) => resolve(value.trim()));
  });

  rl.close();

  if (options && options.length > 0) {
    const asIndex = Number.parseInt(answer, 10);
    if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= options.length) {
      return options[asIndex - 1];
    }
  }

  return answer;
}

async function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (value) => resolve(value.trim()));
  });

  rl.close();
  return answer;
}

async function showToast(
  requestId: string,
  questionId: string | null,
  title: string,
  message: string,
  options: ToastOption[]
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Desktop notifications in this script are only implemented for Windows.');
  }

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    TOAST_SCRIPT,
    '-Title',
    title,
    '-Message',
    message,
    '-RequestId',
    requestId,
    '-OptionsJson',
    JSON.stringify(options),
    '-WorkspacePath',
    process.cwd(),
  ];

  if (questionId) {
    args.push('-QuestionId', questionId);
  }

  await new Promise<void>((resolve, reject) => {
    const ps = spawn('powershell', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    ps.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ps.on('error', reject);
    ps.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `Notification process failed with exit code ${code}`));
    });
  });
}

async function notifyTaskCompletion(
  status: 'completed' | 'failed',
  prompt: string,
  outputPreview: string,
  errorMessage?: string
): Promise<void> {
  const title = status === 'completed' ? 'Codex Task Completed' : 'Codex Task Failed';
  const summary = status === 'completed'
    ? (outputPreview || 'Task finished successfully.')
    : (errorMessage || 'Task ended with an error.');
  const message = truncate(
    `Prompt: ${truncate(prompt, 120)}\n${summary}`,
    260
  );

  try {
    await showToast(
      `turn-complete-${Date.now()}`,
      null,
      title,
      message,
      []
    );
  } catch (error) {
    console.error(`Completion notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class QueueReader {
  private readonly consumed = new Set<string>();
  private readonly startTime = Date.now();

  constructor(private readonly queuePath: string) {}

  private readEntries(): QueueEntry[] {
    const raw = fs.readFileSync(this.queuePath, 'utf8');
    if (!raw.trim()) {
      return [];
    }

    const entries: QueueEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as QueueEntry;
        entries.push(parsed);
      } catch {
        // Ignore malformed queue lines.
      }
    }

    return entries;
  }

  async waitFor(
    matcher: (entry: QueueEntry) => boolean,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<QueueEntry | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const entries = this.readEntries();
      for (const entry of entries) {
        const fingerprint = `${entry.timestamp}:${entry.requestId}:${entry.questionId}:${entry.choice}`;
        if (this.consumed.has(fingerprint)) {
          continue;
        }

        if (entry.timestamp < this.startTime) {
          this.consumed.add(fingerprint);
          continue;
        }

        if (matcher(entry)) {
          this.consumed.add(fingerprint);
          return entry;
        }
      }

      await sleep(400);
    }

    return null;
  }
}

class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private onRequestHandler: ((request: JsonRpcRequest) => Promise<void>) | null = null;
  private onNotificationHandler: ((notification: JsonRpcNotification) => void) | null = null;

  constructor(private readonly childProcess: ReturnType<typeof spawn>) {
    const rl = readline.createInterface({
      input: this.childProcess.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => this.handleLine(line));
    this.childProcess.on('exit', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Codex app-server exited unexpectedly.'));
      }
      this.pending.clear();
    });
  }

  onRequest(handler: (request: JsonRpcRequest) => Promise<void>): void {
    this.onRequestHandler = handler;
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.onNotificationHandler = handler;
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const key = normalizeId(id);

    const message = { id, method, params };
    this.childProcess.stdin!.write(`${JSON.stringify(message)}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    const message = params === undefined ? { method } : { method, params };
    this.childProcess.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.childProcess.stdin!.write(`${JSON.stringify({ id, result })}\n`);
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.onRequestHandler) {
      this.respond(request.id, {});
      return;
    }

    try {
      await this.onRequestHandler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown request handler failure';
      this.respond(request.id, { decision: 'decline', error: message });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const key = normalizeId(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    this.pending.delete(key);
    if (response.error) {
      pending.reject(new Error(response.error.message || 'Unknown JSON-RPC error'));
      return;
    }

    pending.resolve(response.result);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    if (payload && payload.id !== undefined && payload.method) {
      void this.handleRequest(payload as JsonRpcRequest);
      return;
    }

    if (payload && payload.id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
      this.handleResponse(payload as JsonRpcResponse);
      return;
    }

    if (payload && payload.method) {
      this.onNotificationHandler?.(payload as JsonRpcNotification);
    }
  }
}

async function resolveChoiceFromToast(
  queueReader: QueueReader,
  requestId: string,
  questionId: string | null,
  options: ToastOption[]
): Promise<string | null> {
  const allowed = new Set(options.map((option) => option.value));
  const entry = await queueReader.waitFor((candidate) => {
    if (candidate.requestId !== requestId) {
      return false;
    }
    if ((questionId || '') !== (candidate.questionId || '')) {
      return false;
    }
    return !!candidate.choice && allowed.has(candidate.choice);
  });

  return entry?.choice || null;
}

async function handleCommandApproval(
  rpc: JsonRpcConnection,
  queueReader: QueueReader,
  request: JsonRpcRequest
): Promise<void> {
  const params = request.params as any;
  const requestId = String(request.id);
  const command = truncate(params.command || '(unknown command)', 160);
  const reason = params.reason ? `Reason: ${params.reason}` : 'Codex needs approval to run a command.';
  const message = truncate(`${command}\n${reason}`, 260);

  const options: ToastOption[] = [
    { label: 'Approve', value: 'accept' },
    { label: 'Approve Session', value: 'acceptForSession' },
    { label: 'Decline', value: 'decline' },
    { label: 'Cancel', value: 'cancel' },
  ];

  let notificationSent = false;
  try {
    await showToast(requestId, null, 'Codex Command Approval', message, options);
    notificationSent = true;
  } catch (error) {
    console.error(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let choice: string | null = null;
  if (notificationSent) {
    choice = await resolveChoiceFromToast(queueReader, requestId, null, options);
  }

  if (!choice) {
    choice = await promptInTerminal('Choose command approval action', options.map((item) => item.label));
    choice = options.find((item) => item.label === choice)?.value || 'decline';
  }

  rpc.respond(request.id, { decision: choice });
}

async function handleFileChangeApproval(
  rpc: JsonRpcConnection,
  queueReader: QueueReader,
  request: JsonRpcRequest
): Promise<void> {
  const params = request.params as any;
  const requestId = String(request.id);
  const reason = params.reason
    ? `Reason: ${params.reason}`
    : 'Codex needs approval to apply file changes.';
  const message = truncate(reason, 260);

  const options: ToastOption[] = [
    { label: 'Approve', value: 'accept' },
    { label: 'Approve Session', value: 'acceptForSession' },
    { label: 'Decline', value: 'decline' },
    { label: 'Cancel', value: 'cancel' },
  ];

  let notificationSent = false;
  try {
    await showToast(requestId, null, 'Codex File Change Approval', message, options);
    notificationSent = true;
  } catch (error) {
    console.error(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let choice: string | null = null;
  if (notificationSent) {
    choice = await resolveChoiceFromToast(queueReader, requestId, null, options);
  }

  if (!choice) {
    choice = await promptInTerminal('Choose file change approval action', options.map((item) => item.label));
    choice = options.find((item) => item.label === choice)?.value || 'decline';
  }

  rpc.respond(request.id, { decision: choice });
}

async function handleRequestUserInput(
  rpc: JsonRpcConnection,
  queueReader: QueueReader,
  request: JsonRpcRequest
): Promise<void> {
  const params = request.params as any;
  const requestId = String(request.id);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const answers: Record<string, { answers: string[] }> = {};

  for (const question of questions) {
    const questionId = String(question.id || '');
    const optionLabels = Array.isArray(question.options)
      ? question.options.map((option: any) => String(option.label))
      : [];

    let chosenLabel: string | null = null;

    if (optionLabels.length > 0 && optionLabels.length <= 5) {
      const options: ToastOption[] = optionLabels.map((label, index) => ({
        label: truncate(label, 40),
        value: String(index),
      }));

      const title = truncate(`Codex Input: ${question.header || 'Question'}`, 80);
      const message = truncate(String(question.question || 'Choose an option'), 260);

      let notificationSent = false;
      try {
        await showToast(requestId, questionId, title, message, options);
        notificationSent = true;
      } catch (error) {
        console.error(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const choice = notificationSent
        ? await resolveChoiceFromToast(queueReader, requestId, questionId, options)
        : null;

      if (choice !== null) {
        const index = Number.parseInt(choice, 10);
        if (!Number.isNaN(index) && index >= 0 && index < optionLabels.length) {
          chosenLabel = optionLabels[index];
        }
      }
    }

    if (!chosenLabel) {
      chosenLabel = await promptInTerminal(String(question.question || 'Enter a response'), optionLabels.length > 0 ? optionLabels : null);
    }

    answers[questionId] = { answers: [chosenLabel] };
  }

  rpc.respond(request.id, { answers });
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  if (!cli.daemon && !cli.prompt) {
    console.error('Provide a prompt. Example: npm run codex:notify -- "Summarize this repo"');
    process.exit(1);
  }

  ensureState();

  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.trim()) {
      process.stderr.write(text);
    }
  });

  const rpc = new JsonRpcConnection(child);
  const queueReader = new QueueReader(QUEUE_PATH);
  type ActiveTurn = {
    turnId: string;
    streamed: boolean;
    outputText: string;
    resolve: (turn: any) => void;
  };
  let activeTurn: ActiveTurn | null = null;

  rpc.onNotification((notification) => {
    if (notification.method === 'item/agentMessage/delta') {
      const params = notification.params as any;
      const delta = params?.delta;
      if (
        activeTurn &&
        params?.turnId === activeTurn.turnId &&
        typeof delta === 'string'
      ) {
        activeTurn.streamed = true;
        activeTurn.outputText += delta;
        process.stdout.write(delta);
      }
    }

    if (notification.method === 'turn/completed') {
      const params = notification.params as any;
      if (activeTurn && params?.turn?.id === activeTurn.turnId) {
        const currentTurn = activeTurn;
        activeTurn = null;
        currentTurn.resolve(params.turn);
      }
    }

    if (notification.method === 'error') {
      const message = notification.params?.message;
      if (message) {
        console.error(`\n[codex] ${message}`);
      }
    }
  });

  rpc.onRequest(async (request) => {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval':
        await handleCommandApproval(rpc, queueReader, request);
        break;
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
        await handleFileChangeApproval(rpc, queueReader, request);
        break;
      case 'item/tool/requestUserInput':
        await handleRequestUserInput(rpc, queueReader, request);
        break;
      default:
        rpc.respond(request.id, {});
        break;
    }
  });

  await rpc.request('initialize', {
    clientInfo: { name: 'codex-notify-bridge', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');

  const threadStart = await rpc.request('thread/start', {
    cwd: process.cwd(),
    experimentalRawEvents: false,
  });

  const threadId = threadStart?.thread?.id;
  if (!threadId) {
    throw new Error('Failed to create a Codex thread.');
  }

  async function runTurn(prompt: string): Promise<void> {
    if (activeTurn) {
      throw new Error('A turn is already running.');
    }

    let resolveTurn: (turn: any) => void = () => {};
    const turnCompleted = new Promise<any>((resolve) => {
      resolveTurn = resolve;
    });

    const turnState: ActiveTurn = {
      turnId: '',
      streamed: false,
      outputText: '',
      resolve: resolveTurn,
    };
    activeTurn = turnState;
    let completionNotified = false;

    try {
      const turnStart = await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });

      turnState.turnId = turnStart?.turn?.id || '';
      if (!turnState.turnId) {
        activeTurn = null;
        throw new Error('Failed to start Codex turn.');
      }

      const turn = await turnCompleted;
      if (turnState.streamed) {
        process.stdout.write('\n');
      }

      if (!turn || turn.status !== 'completed') {
        const errorMessage = turn?.error?.message || 'Turn did not complete successfully.';
        await notifyTaskCompletion('failed', prompt, '', errorMessage);
        completionNotified = true;
        throw new Error(errorMessage);
      }

      await notifyTaskCompletion(
        'completed',
        prompt,
        truncate(turnState.outputText.trim(), 180)
      );
      completionNotified = true;
    } catch (error) {
      if (turnState.turnId && !completionNotified) {
        await notifyTaskCompletion(
          'failed',
          prompt,
          '',
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  }

  if (cli.prompt) {
    await runTurn(cli.prompt);
  }

  if (cli.daemon) {
    if (!cli.prompt) {
      console.log('Codex notify daemon is running. Enter prompts below.');
      console.log('Type /exit to quit.');
    }

    while (true) {
      const line = await askLine('codex> ');
      if (!line) {
        continue;
      }
      if (line === '/exit' || line === '/quit') {
        break;
      }

      try {
        await runTurn(line);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  child.kill();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
