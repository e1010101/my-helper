/**
 * Token accounting for the assistant loop.
 *
 * The provider reports the *actual* token counts, which is the ground truth for
 * cost. It does not report how those tokens divide between the fixed overhead
 * (system prompt and tool definitions) and the conversation. That split is what
 * tells you whether memory is bloating requests or whether the tool schemas are
 * simply expensive, so it is estimated here by character share.
 *
 * The estimate is deliberately crude: it exists to answer "which component
 * dominates", not to predict billing. Applying one ratio to every component
 * means the ratios between them are meaningful even though the absolute numbers
 * are approximate.
 */

/** Rough characters-per-token. English prose sits near 4; JSON sits nearer 3. */
const CHARS_PER_TOKEN = 3.8;

export interface RequestComposition {
  /** System prompt, including the injected current time. */
  systemChars: number;
  /** Serialised tool declarations — usually the largest fixed cost. */
  toolsChars: number;
  /** Conversation history plus the new user message. */
  messagesChars: number;
}

export interface TokenBreakdown {
  system: number;
  tools: number;
  messages: number;
  /** Sum of the three, which should approximate the provider's prompt_tokens. */
  estimatedPromptTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimated tokens for a raw character count. */
function estimateFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Splits the provider's prompt token count across components in proportion to
 * their character length, so the parts always sum to the reported total.
 *
 * Scaling to the real total rather than reporting raw estimates keeps the
 * numbers consistent: an estimate of 1,200 against an actual of 900 would
 * otherwise look like a bug.
 */
export function breakdownRequest(
  composition: RequestComposition,
  actualPromptTokens?: number
): TokenBreakdown {
  const { systemChars, toolsChars, messagesChars } = composition;
  const totalChars = systemChars + toolsChars + messagesChars;

  const share = (chars: number) => (totalChars === 0 ? 0 : chars / totalChars);

  if (!actualPromptTokens || actualPromptTokens <= 0) {
    return {
      system: estimateFromChars(systemChars),
      tools: estimateFromChars(toolsChars),
      messages: estimateFromChars(messagesChars),
      estimatedPromptTokens: estimateFromChars(totalChars),
    };
  }

  return {
    system: Math.round(actualPromptTokens * share(systemChars)),
    tools: Math.round(actualPromptTokens * share(toolsChars)),
    messages: Math.round(actualPromptTokens * share(messagesChars)),
    estimatedPromptTokens: actualPromptTokens,
  };
}
