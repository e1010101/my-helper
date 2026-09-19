import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env file');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/** Telegram only accepts these characters in a webhook secret token. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_message?: string;
}

async function callTelegram<T>(method: string, body?: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`${API_BASE}/${method}`, body
    ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
    : undefined);

  return await response.json() as TelegramApiResponse<T>;
}

function resolveSecretToken(): string | undefined {
  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (!secret) {
    return undefined;
  }
  if (!SECRET_PATTERN.test(secret)) {
    console.error('❌ WEBHOOK_SECRET is invalid: use only A-Z, a-z, 0-9, "_" and "-" (max 256 chars)');
    process.exit(1);
  }
  return secret;
}

async function showWebhookInfo(): Promise<void> {
  console.log('Checking webhook status...\n');
  const info = await callTelegram<WebhookInfo>('getWebhookInfo');

  if (!info.ok || !info.result) {
    console.error('❌ Error:', info.description || 'unknown error');
    return;
  }

  console.log('✅ Webhook Info:');
  console.log(`   URL: ${info.result.url || '(not set)'}`);
  console.log(`   Pending updates: ${info.result.pending_update_count || 0}`);
  console.log(`   Last error: ${info.result.last_error_message || 'none'}`);

  if (info.result.url) {
    console.log('\n⚠️  Webhook is active. Local polling mode will not work.');
    console.log('   Run: npm run webhook:delete');
  } else {
    console.log('\n✅ No webhook set. Polling mode will work.');
  }
}

async function removeWebhook(): Promise<void> {
  console.log('Deleting webhook...\n');
  const result = await callTelegram<boolean>('deleteWebhook');

  if (result.ok) {
    console.log('✅ Webhook deleted successfully!');
    console.log('   You can now run the bot locally with: npm run dev');
  } else {
    console.error('❌ Error:', result.description || 'unknown error');
  }
}

async function registerWebhook(url: string): Promise<void> {
  const secret = resolveSecretToken();
  console.log(`Setting webhook to: ${url}\n`);

  if (secret) {
    console.log('Using WEBHOOK_SECRET from environment.\n');
  } else {
    console.log('⚠️  WEBHOOK_SECRET is not set: /webhook will accept unauthenticated requests.\n');
  }

  const result = await callTelegram<boolean>('setWebhook', secret ? { url, secret_token: secret } : { url });

  if (result.ok) {
    console.log('✅ Webhook set successfully!');
    console.log('   Your bot will now receive updates via webhook.');
    console.log('   Local polling mode will NOT work while webhook is active.');
    if (secret) {
      console.log('   Remember to set the same WEBHOOK_SECRET in your hosting environment.');
    }
  } else {
    console.error('❌ Error:', result.description || 'unknown error');
  }
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  npm run webhook:info    - Check current webhook status');
  console.log('  npm run webhook:delete  - Delete webhook (enable polling)');
  console.log('  npm run webhook:set URL - Set webhook URL');
  console.log('\nExamples:');
  console.log('  npm run webhook:info');
  console.log('  npm run webhook:delete');
  console.log('  npm run webhook:set https://my-bot.railway.app/webhook');
}

async function main(): Promise<void> {
  const command = process.argv[2];

  console.log('🤖 Telegram Webhook Manager\n');

  switch (command) {
    case 'info':
    case 'check':
      await showWebhookInfo();
      break;

    case 'delete':
    case 'remove':
      await removeWebhook();
      break;

    case 'set': {
      const url = process.argv[3];
      if (!url) {
        console.error('❌ Please provide a webhook URL');
        console.log('   Usage: npm run webhook:set https://your-domain.railway.app/webhook');
        process.exit(1);
      }
      await registerWebhook(url);
      break;
    }

    default:
      printUsage();
  }
}

main().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
