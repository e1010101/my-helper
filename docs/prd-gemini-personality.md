# Product Requirements Document (PRD): Gemini AI Personality Integration

## 1. Objective
Enhance the existing Telegram bot by integrating the Gemini API, giving the bot a distinct, customizable personality, and allowing it to robustly answer open-ended questions and engage in natural conversations when users send non-command messages.

## 2. Motivation
Currently, the bot is highly functional for specific tasks (e.g., `/task` creation, `/stats`) but ignores or gives generic responses to regular text messages. Adding an AI layer makes the bot more engaging, helpful, and accessible, acting as a true "personal assistant."

## 3. Features & Requirements

### 3.1. Core Functionality
- **Open-Ended Conversation:** Any text message that does not start with a `/` (slash command) should be routed to the Gemini AI model.
- **Personality Injection:** The bot must have a configurable "System Prompt" (e.g., set via an environment variable or hardcoded constant) that dictates its tone, constraints, and behavior (e.g., "You are a witty, helpful personal assistant...").
- **Typing Status:** The bot should display a "typing..." action in Telegram while waiting for the Gemini API response to improve UX.
- **Context Awareness (V1):** The bot should maintain a short-term conversational history (e.g., the last 10 messages per user) to allow for follow-up questions. This can be stored in memory or in the existing `user_data` Supabase table.
- **Markdown Formatting:** The bot should successfully parse and render Gemini's Markdown responses into Telegram's supported MarkdownV2 or HTML format.

### 3.2. Non-Functional Requirements
- **Performance:** Responses should generally be delivered within 2-4 seconds.
- **Error Handling:** If the Gemini API fails, times out, or blocks a response due to safety settings, the bot should gracefully inform the user (e.g., "Sorry, I couldn't process that right now.").
- **Security & Privacy:**
  - AI conversations must not leak to other users. Contexts must be strictly separated by `userId`.
  - The API key must be securely managed via a `.env` variable (`GEMINI_API_KEY`).

### 3.3. Out of Scope for V1
- Voice message transcription (audio to text).
- Image generation or multimodal vision queries (text-only for now).
- Long-term vector database memory (RAG).

## 4. Technical Architecture

### 4.1. Dependencies
- Add the official Google Gen AI SDK: `npm install @google/genai`

### 4.2. Environment Variables
- `GEMINI_API_KEY`: Required for authentication with the Gemini API.
- `BOT_PERSONALITY_PROMPT` (Optional): To easily tweak the personality without changing code.

### 4.3. Implementation Steps Outline
1. **Setup SDK**: Initialize the Gemini client in a new service file (e.g., `src/services/ai.ts`).
2. **Context Management**: Create a lightweight memory store (Map with TTL, or Supabase) mapping `userId` -> `ChatMessage[]`.
3. **Message Handler**: In `src/commands/index.ts` or `src/bot.ts`, add a `bot.on('text', ...)` handler that triggers when no other commands match.
4. **Formatting Utilities**: Ensure Gemini's markdown is translated to Telegram's expected entity formats.

## 5. Success Metrics
- **Engagement**: Increase in non-command text messages sent to the bot.
- **Reliability**: < 2% error rate on API calls to Gemini.
- **Latency**: Average response time under 3 seconds.
