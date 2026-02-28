import { Context } from 'telegraf';

type PromptField = 'title' | 'prompt' | 'tags' | 'image';

interface PromptDraft {
    chatId: number;
    title?: string;
    promptText?: string;
    tags?: string[];
    imageFileId?: string;
    step: PromptField;
}

const promptDrafts = new Map<number, PromptDraft>();

export function isUserInPromptFlow(userId: number): boolean {
    return promptDrafts.has(userId);
}

export async function promptCommand(ctx: Context) {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) {
        await ctx.reply('❌ Could not identify user');
        return;
    }

    // Initialize a new draft and set the step to 'title'
    const draft: PromptDraft = {
        chatId,
        step: 'title'
    };
    promptDrafts.set(userId, draft);

    await ctx.reply(
        "📝 Let's create a new prompt template.\nPlease send me the **Title** for this prompt.",
        { parse_mode: 'Markdown' }
    );
}

export async function promptTextInputHandler(ctx: Context) {
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
        await ctx.reply("Great! Now, send me the **Prompt text**.", { parse_mode: 'Markdown' });
        return true; // Handled
    } else if (draft.step === 'prompt') {
        draft.promptText = text;
        draft.step = 'tags';
        promptDrafts.set(userId, draft);
        await ctx.reply("Got it. Send me comma-separated **Tags** for this prompt (e.g., coding, writing), or send 'skip'.", { parse_mode: 'Markdown' });
        return true; // Handled
    } else if (draft.step === 'tags') {
        if (text.toLowerCase() === 'skip') {
            draft.tags = [];
        } else {
            draft.tags = text.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
        }
        draft.step = 'image';
        promptDrafts.set(userId, draft);
        await ctx.reply("Almost done. Please send an **Image** to associate with this prompt. It will be stored in full resolution.", { parse_mode: 'Markdown' });
        return true; // Handled
    }

    return false;
}

export async function promptPhotoInputHandler(ctx: Context) {
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
        const { db } = await import('../services/database.js');
        await db.savePrompt(userId, draft.title, draft.promptText, draft.tags || [], draft.imageFileId);

        promptDrafts.delete(userId);
        await ctx.reply(`✅ Prompt '${draft.title}' saved successfully!`);
    } catch (error) {
        console.error('Error saving prompt to database:', error);
        await ctx.reply('❌ Failed to save prompt. Please try again later.');
    }

    return true;
}
