import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env file');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function getWebhookInfo() {
  const response = await fetch(`${API_BASE}/getWebhookInfo`);
  const data = await response.json();
  return data;
}

async function deleteWebhook() {
  const response = await fetch(`${API_BASE}/deleteWebhook`);
  const data = await response.json();
  return data;
}

async function setWebhook(url: string) {
  const response = await fetch(`${API_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await response.json();
  return data;
}

async function main() {
  const command = process.argv[2];

  console.log('🤖 Telegram Webhook Manager\n');

  switch (command) {
    case 'info':
    case 'check':
      console.log('Checking webhook status...\n');
      const info = await getWebhookInfo();
      if (info.ok) {
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
      } else {
        console.error('❌ Error:', info.description);
      }
      break;

    case 'delete':
    case 'remove':
      console.log('Deleting webhook...\n');
      const deleteResult = await deleteWebhook();
      if (deleteResult.ok) {
        console.log('✅ Webhook deleted successfully!');
        console.log('   You can now run the bot locally with: npm run dev');
      } else {
        console.error('❌ Error:', deleteResult.description);
      }
      break;

    case 'set':
      const url = process.argv[3];
      if (!url) {
        console.error('❌ Please provide a webhook URL');
        console.log('   Usage: npm run webhook:set https://your-domain.railway.app/webhook');
        process.exit(1);
      }
      console.log(`Setting webhook to: ${url}\n`);
      const setResult = await setWebhook(url);
      if (setResult.ok) {
        console.log('✅ Webhook set successfully!');
        console.log('   Your bot will now receive updates via webhook.');
        console.log('   Local polling mode will NOT work while webhook is active.');
      } else {
        console.error('❌ Error:', setResult.description);
      }
      break;

    default:
      console.log('Usage:');
      console.log('  npm run webhook:info    - Check current webhook status');
      console.log('  npm run webhook:delete  - Delete webhook (enable polling)');
      console.log('  npm run webhook:set URL - Set webhook URL');
      console.log('\nExamples:');
      console.log('  npm run webhook:info');
      console.log('  npm run webhook:delete');
      console.log('  npm run webhook:set https://my-bot.railway.app/webhook');
  }
}

main().catch(console.error);
