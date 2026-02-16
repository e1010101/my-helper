import { Bot } from './bot.js';

async function main() {
  try {
    console.log('🚀 Initializing bot...');
    const bot = new Bot();
    await bot.start();
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
