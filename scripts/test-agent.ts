import { aiService } from '../src/services/ai.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  console.log('Sending message to agent: "Find prompts about programming"');
  try {
    // using a dummy user ID 1
    const response = await aiService.agentResponse(1, 'Find prompts about programming');
    console.log('Agent Response:\n', response);
  } catch (err) {
    console.error('Agent failed with err:\n', err);
  }
}

run();
