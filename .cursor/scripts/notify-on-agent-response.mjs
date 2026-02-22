#!/usr/bin/env node
/**
 * Cursor hook: shows a desktop notification when the agent has finished a response
 * (i.e. when it is waiting for your input). Uses node-notifier for native toasts.
 *
 * Receives JSON on stdin from Cursor (afterAgentResponse payload).
 * Must write JSON to stdout (e.g. {}).
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notifier = require('node-notifier');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on('error', reject);
  });
}

async function main() {
  let payload = {};
  try {
    payload = await readStdin();
  } catch (_) {
    // no stdin or invalid JSON
  }

  const title = 'Cursor Agent';
  const message = 'Agent finished a response — your turn to reply or approve.';

  notifier.notify(
    {
      title,
      message,
      sound: true,
    },
    (err) => {
      if (err) console.error('Notify error:', err);
    }
  );

  // Required: hook must output JSON to stdout
  process.stdout.write(JSON.stringify({}));
}

main().catch((err) => {
  console.error(err);
  process.stdout.write(JSON.stringify({}));
  process.exit(1);
});
