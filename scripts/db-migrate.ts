/**
 * Applies docs/database-schema.sql to the Supabase database.
 *
 * Uses psql rather than the Supabase JS client because the schema contains
 * DDL that PostgREST cannot execute (CREATE FUNCTION bodies, DO blocks,
 * ALTER TABLE ... ENABLE ROW LEVEL SECURITY). psql is the supported path.
 *
 * The connection string is passed through the environment, never as an
 * argument, so the password cannot leak into shell history or process lists.
 *
 * Usage: npm run db:migrate
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = join(projectRoot, 'docs', 'database-schema.sql');

/** Minimal .env reader: KEY=VALUE lines, ignoring comments and blank lines. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function fail(message: string, hint?: string): never {
  console.error(`\n❌ ${message}`);
  if (hint) {
    console.error(`\n${hint}`);
  }
  process.exit(1);
}

interface ConnectionParts {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/**
 * Splits a postgres:// URI into discrete libpq settings.
 *
 * Passing them as environment variables rather than a connection string keeps
 * the password out of argv (visible in process lists) and avoids libpq
 * URI-parsing differences.
 */
function parseConnectionString(connectionString: string): ConnectionParts {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    fail(
      'DATABASE_URL is not a valid postgres:// URI.',
      'Expected something like postgresql://postgres.abcdefgh:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres'
    );
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    fail(`DATABASE_URL must use the postgres:// scheme (got "${url.protocol}//").`);
  }

  const database = url.pathname.replace(/^\//, '') || 'postgres';
  if (!url.hostname || !url.username) {
    fail('DATABASE_URL is missing a host or user.');
  }

  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function runPsql(
  connection: ConnectionParts,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('psql', args, {
      env: {
        ...process.env,
        PGHOST: connection.host,
        PGPORT: connection.port,
        PGUSER: connection.user,
        PGPASSWORD: connection.password,
        PGDATABASE: connection.database,
        PGCONNECT_TIMEOUT: '15',
        // Supabase requires TLS. Overridable so the same script can be pointed
        // at a local Postgres for testing.
        PGSSLMODE: process.env.PGSSLMODE || 'require',
      },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolvePromise({ code: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

const envFile = readEnvFile(join(projectRoot, '.env'));
const connectionString = process.env.DATABASE_URL || envFile.DATABASE_URL;

if (!connectionString) {
  fail(
    'DATABASE_URL is not set.',
    [
      'Add it to .env (see .env.example). In Supabase:',
      '  Project Settings -> Database -> Connection string -> URI',
      '  Use the "Connection pooling" / Supavisor URI if your network has no IPv6,',
      '  and replace [YOUR-PASSWORD] with your database password.',
      '',
      'Alternatively paste docs/database-schema.sql into the Supabase SQL Editor.',
    ].join('\n')
  );
}

if (!existsSync(schemaPath)) {
  fail(`Schema file not found: ${schemaPath}`);
}

const connection = parseConnectionString(connectionString);

console.log('📦 Applying docs/database-schema.sql');
console.log(`   target: ${connection.user}@${connection.host}:${connection.port}/${connection.database}`);
console.log('');

// -v ON_ERROR_STOP=1 makes psql exit non-zero on the first failed statement
// instead of ploughing on and leaving a half-migrated database.
const migrate = await runPsql(connection, [
  '--no-psqlrc',
  '--quiet',
  '-v',
  'ON_ERROR_STOP=1',
  '-f',
  schemaPath,
]);

if (migrate.stdout.trim()) {
  console.log(migrate.stdout.trim());
}

if (migrate.code !== 0) {
  if (migrate.code === -1) {
    fail(
      'Could not run psql. Is it installed and on PATH?',
      `Details: ${migrate.stderr.trim()}`
    );
  }
  fail(`Migration failed (psql exit ${migrate.code}).`, migrate.stderr.trim());
}

console.log('✅ Schema applied.');

// --- Verification ---------------------------------------------------------

const REQUIRED_TABLES = [
  'user_data',
  'command_history',
  'tasks',
  'prompts',
  'conversations',
  'facts',
  'reminders',
  'pending_actions',
  'credentials',
  'health_probes',
];

const RLS_TABLES = ['conversations', 'facts', 'reminders', 'pending_actions', 'credentials', 'health_probes'];

const verifySql = `
SELECT json_agg(row_to_json(t) ORDER BY t.table_name)
FROM (
  SELECT c.relname AS table_name,
         c.relrowsecurity AS rls_enabled,
         (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
) t;
`;

const verify = await runPsql(connection, ['--no-psqlrc', '--tuples-only', '--no-align', '-c', verifySql]);

if (verify.code !== 0) {
  console.log('\n⚠️  Could not verify (the schema was still applied):');
  console.log(verify.stderr.trim());
  process.exit(0);
}

interface TableStatus {
  table_name: string;
  rls_enabled: boolean;
  policies: number;
}

let tables: TableStatus[] = [];
try {
  tables = JSON.parse(verify.stdout.trim() || '[]') as TableStatus[];
} catch {
  console.log('\n⚠️  Could not parse verification output:');
  console.log(verify.stdout.trim());
  process.exit(0);
}

const byName = new Map(tables.map((table) => [table.table_name, table]));
const missing = REQUIRED_TABLES.filter((name) => !byName.has(name));

console.log('\n📋 Table status');
for (const name of REQUIRED_TABLES) {
  const status = byName.get(name);
  if (!status) {
    console.log(`   ❌ ${name.padEnd(18)} missing`);
    continue;
  }
  const rls = status.rls_enabled ? 'RLS on ' : 'RLS off';
  const shouldHaveRls = RLS_TABLES.includes(name);
  const rlsFlag = shouldHaveRls && !status.rls_enabled ? ' ⚠️ expected RLS' : '';
  console.log(`   ${status.rls_enabled || !shouldHaveRls ? '✅' : '⚠️ '} ${name.padEnd(18)} ${rls}, ${status.policies} policy(ies)${rlsFlag}`);
}

if (missing.length > 0) {
  console.log(`\n❌ Missing tables: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('\n✅ All required tables exist.');
console.log('\nNext: set SUPABASE_SERVICE_ROLE_KEY (Project Settings -> API) so the bot');
console.log('can read the RLS-protected tables, then start the bot and check /health.');
