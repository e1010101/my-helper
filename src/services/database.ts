import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

export interface Task {
  id: number;
  user_id: number;
  name: string;
  description: string;
  completed: boolean;
  created_at: string;
}

export interface Prompt {
  id: number;
  user_id: number;
  title: string;
  prompt: string;
  tags: string[];
  image_file_id: string;
  created_at: string;
  updated_at: string;
}

/** Postgres/Supabase error code for "no rows returned by .single()". */
const NO_ROWS_CODE = 'PGRST116';

export class DatabaseService {
  private client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    if (client) {
      this.client = client;
      return;
    }

    const supabase = env.supabase();
    // The service_role key bypasses RLS, which the locked-down tables require.
    // Falling back to the anon key keeps older deployments booting, but those
    // tables will reject the queries and the health check will say so.
    this.client = createClient(
      supabase.url,
      supabase.serviceRoleKey || supabase.anonKey
    );
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  // Example: Store user data
  async saveUserData(userId: number, data: Record<string, unknown>) {
    const { error } = await this.client
      .from('user_data')
      .upsert({ user_id: userId, data, updated_at: new Date() });

    if (error) {
      console.error('Error saving user data:', error);
      throw error;
    }
  }

  // Example: Get user data
  async getUserData(userId: number) {
    const { data, error } = await this.client
      .from('user_data')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      console.error('Error getting user data:', error);
      throw error;
    }

    return data;
  }

  // Example: Store command history
  async logCommand(userId: number, command: string) {
    const { error } = await this.client
      .from('command_history')
      .insert({ user_id: userId, command, created_at: new Date() });

    if (error) {
      console.error('Error logging command:', error);
    }
  }

  async createTask(userId: number, name: string, description: string) {
    const { error } = await this.client
      .from('tasks')
      .insert({ user_id: userId, name, description });

    if (error) {
      console.error('Error creating task:', error);
      throw error;
    }
  }

  async getTask(taskId: number, userId: number): Promise<Task | null> {
    const { data, error } = await this.client
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('user_id', userId)
      .single();

    // .single() errors when no row matches; that is an expected "not found",
    // not a failure, so callers get null and can report it properly.
    if (error) {
      if (error.code === NO_ROWS_CODE) {
        return null;
      }
      console.error('Error fetching task:', error);
      throw error;
    }

    return data;
  }

  async updateTaskStatus(taskId: number, userId: number, completed: boolean) {
    const { error } = await this.client
      .from('tasks')
      .update({ completed })
      .eq('id', taskId)
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating task status:', error);
      throw error;
    }
  }

  async updateTask(taskId: number, userId: number, name: string, description: string) {
    const { error } = await this.client
      .from('tasks')
      .update({ name, description })
      .eq('id', taskId)
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating task details:', error);
      throw error;
    }
  }

  async deleteTask(taskId: number, userId: number) {
    const { error } = await this.client
      .from('tasks')
      .delete()
      .eq('id', taskId)
      .eq('user_id', userId);

    if (error) {
      console.error('Error deleting task:', error);
      throw error;
    }
  }

  async getTasksByUser(userId: number, limit = 20): Promise<Task[]> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, user_id, name, description, completed, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching tasks:', error);
      throw error;
    }

    return data || [];
  }

  // --- Prompts Feature ---

  async savePrompt(userId: number, title: string, prompt: string, tags: string[], imageFileId: string) {
    const { error } = await this.client
      .from('prompts')
      .insert({
        user_id: userId,
        title,
        prompt,
        tags,
        image_file_id: imageFileId,
        created_at: new Date(),
        updated_at: new Date()
      });

    if (error) {
      console.error('Error saving prompt:', error);
      throw error;
    }
  }

  async getPromptsByUser(userId: number, limit = 20): Promise<Prompt[]> {
    const { data, error } = await this.client
      .from('prompts')
      .select('id, user_id, title, prompt, tags, image_file_id, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching prompts:', error);
      throw error;
    }

    return data || [];
  }

  async searchPrompts(userId: number, titleQuery?: string, tagsQuery?: string[]): Promise<Prompt[]> {
    let query = this.client
      .from('prompts')
      .select('id, user_id, title, prompt, tags, image_file_id, created_at, updated_at')
      .eq('user_id', userId);

    if (titleQuery) {
      query = query.ilike('title', `%${titleQuery}%`);
    }

    if (tagsQuery && tagsQuery.length > 0) {
      query = query.contains('tags', tagsQuery);
    }

    // Default order by newest
    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('Error searching prompts:', error);
      throw error;
    }

    return data || [];
  }
}

export const db = new DatabaseService();
