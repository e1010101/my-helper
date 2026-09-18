import { Context } from 'telegraf';
import { db } from '../services/database.js';
import { escapeHtml } from '../utils/telegram-format.js';

type PromptField = 'title' | 'prompt' | 'tags' | 'image';

interface PromptDraft {
    chatId: number;
    title?: string;
    promptText?: string;
    tags?: string[];
    imageFileId?: string;
    step: PromptField;
}

/** One in-progress draft per user, so a form never bleeds across users. */
const promptDrafts = new Map<number, PromptDraft>();

export function isUserInPromptFlow(userId: number): boolean {
    return promptDrafts.has(userId);
}

function resetDraft(userId: number, chatId: number): PromptDraft {
    const draft: PromptDraft = { chatId, step: 'title' };
    promptDrafts.set(userId, draft);
    return draft;
}

export async function promptCommand(ctx: Context) {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) {
        await ctx.reply('❌ Could not identify user');
        return;
    }

    // Starting over discards any half-finished draft.
    const discarded = promptDrafts.delete(userId);
    resetDraft(userId, chatId);

    const restartNote = discarded
        ? '\n\n_Your previous unfinished prompt draft was discarded._'
        : '';

    await ctx.reply(
        `📝 Let's create a new prompt template.\nPlease send me the <b>Title</b> for this prompt.${restartNote}`,
        { parse_mode: 'HTML' }
    );
}

export async function promptTextInputHandler(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';

    if (!userId || !text || text.startsWith('/')) {
        return false; // Return false to indicate text was not handled by this function
    }

    const draft = promptDrafts.get(userId);
    if (!draft) {
        return false;
    }

    if (draft.step === 'title') {
        draft.title = text;
        draft.step = 'prompt';
        promptDrafts.set(userId, draft);
        await ctx.reply('Great! Now, send me the <b>Prompt text</b>.', { parse_mode: 'HTML' });
        return true; // Handled
    }

    if (draft.step === 'prompt') {
        draft.promptText = text;
        draft.step = 'tags';
        promptDrafts.set(userId, draft);
        await ctx.reply("Got it. Send me comma-separated <b>Tags</b> for this prompt (e.g., coding, writing), or send 'skip'.", { parse_mode: 'HTML' });
        return true; // Handled
    }

    if (draft.step === 'tags') {
        if (text.toLowerCase() === 'skip') {
            draft.tags = [];
        } else {
            draft.tags = text.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
        }
        draft.step = 'image';
        promptDrafts.set(userId, draft);
        await ctx.reply('Almost done. Please send an <b>Image</b> to associate with this prompt. It will be stored in full resolution.', { parse_mode: 'HTML' });
        return true; // Handled
    }

    // The draft is waiting for an image. Without this branch the draft would
    // live forever, silently swallowing every later message from this user, so
    // instead we treat the text as an explicit abort.
    promptDrafts.delete(userId);
    await ctx.reply(
        '🚫 Prompt creation cancelled because no image was sent. Use /prompt to start again.'
    );
    return true;
}

export async function promptPhotoInputHandler(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const photo = ctx.message && 'photo' in ctx.message ? ctx.message.photo : null;

    if (!userId || !photo || photo.length === 0) {
        return false;
    }

    const draft = promptDrafts.get(userId);
    if (!draft || draft.step !== 'image') {
        return false;
    }

    // Telegram sends multiple sizes. The last element is the highest resolution.
    const highestResolutionPhoto = photo[photo.length - 1];
    draft.imageFileId = highestResolutionPhoto.file_id;

    if (!draft.title || !draft.promptText) {
        promptDrafts.delete(userId);
        await ctx.reply('❌ Error: Missing title or prompt text. Please start over with /prompt.');
        return true;
    }

    try {
        await db.savePrompt(userId, draft.title, draft.promptText, draft.tags || [], draft.imageFileId);

        promptDrafts.delete(userId);
        await ctx.reply(`✅ Prompt '${escapeHtml(draft.title)}' saved successfully!`, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Error saving prompt to database:', error);
        // Keep the draft so the user can simply resend the photo and retry.
        await ctx.reply('❌ Failed to save prompt. Please try again later.');
    }

    return true;
}
