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

  async getTask(taskId: number, userId: number) {
    const { data, error } = await this.client
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('user_id', userId)
      .single();

    if (error) {
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

  async getTasksByUser(userId: number, limit = 20) {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, name, description, completed, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching tasks:', error);
      throw error;
    }

    return data || [];
  }
}

export const db = new DatabaseService();
