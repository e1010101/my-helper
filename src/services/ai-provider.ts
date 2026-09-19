import { env } from '../config/env.js';
import { logger } from './logger.js';
import type { AIClient } from './ai-client.js';
import { GeminiProvider } from './gemini-provider.js';
import { DeepSeekProvider } from './deepseek-provider.js';

/**
 * Builds the configured model provider. Which one is chosen (and the errors
 * when the configuration is ambiguous) lives in `env.aiProvider()`.
 */
export function createAIClient(): AIClient {
  const provider = env.aiProvider();

  if (provider === 'deepseek') {
    const { model } = env.deepseek();
    logger.info(`Using DeepSeek provider (${model})`);
    return new DeepSeekProvider();
  }

  logger.info('Using Gemini provider');
  return new GeminiProvider();
}
