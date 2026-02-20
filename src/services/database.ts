import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

export class DatabaseService {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(config.supabase.url, config.supabase.anonKey);
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
}

export const db = new DatabaseService();
