import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('external HTTP attempts fail the test process even when application code catches them', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'my-helper-network-'));
  const scripts = [
    'import { test } from "node:test"; test("fetch probe", async () => { try { await fetch("https://example.invalid"); } catch {} });',
    'import { test } from "node:test"; import https from "node:https"; test("https probe", () => { try { https.get("https://example.invalid"); } catch {} });',
  ];
  try {
    for (const [index, script] of scripts.entries()) {
      const fixture = join(fixtureDirectory, `probe-${index}.test.mjs`);
      writeFileSync(fixture, script);
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', '--import', './tests/helpers/no-network.ts',
        '--test', fixture,
      ], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, 'swallowing a blocked network error must not pass the test');
      assert.match(result.stdout + result.stderr, /Unexpected external network request/);
    }
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
