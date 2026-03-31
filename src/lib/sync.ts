import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import type { AgentProfile } from '@/types';

export interface UserPreferences {
  darkMode: boolean;
  language: string;
  terminalTheme: string;
  terminalFont: string;
  terminalFontSize: number;
  terminalLigatures: boolean;
}

export async function fetchPreferences(userId: string): Promise<UserPreferences | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();
    if (error || !data) return null;
    return {
      darkMode: data.dark_mode,
      language: data.language,
      terminalTheme: data.terminal_theme,
      terminalFont: data.terminal_font,
      terminalFontSize: data.terminal_font_size,
      terminalLigatures: data.terminal_ligatures,
    };
  } catch {
    return null;
  }
}

export async function pushPreferences(userId: string, prefs: UserPreferences): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase.from('user_preferences').upsert({
      user_id: userId,
      dark_mode: prefs.darkMode,
      language: prefs.language,
      terminal_theme: prefs.terminalTheme,
      terminal_font: prefs.terminalFont,
      terminal_font_size: prefs.terminalFontSize,
      terminal_ligatures: prefs.terminalLigatures,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Failed to push preferences:', e);
  }
}

export async function fetchAgentProfiles(userId: string): Promise<AgentProfile[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data, error } = await supabase
      .from('agent_profiles')
      .select('*')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return [];
    return data.map((row: any) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      model: row.model || '',
      apiKey: row.api_key || '',
      systemPrompt: row.system_prompt || '',
      autonomous: row.autonomous || false,
    }));
  } catch {
    return [];
  }
}

export async function pushAgentProfiles(userId: string, profiles: AgentProfile[]): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase.from('agent_profiles').delete().eq('user_id', userId);
    if (profiles.length > 0) {
      await supabase.from('agent_profiles').insert(
        profiles.map((p) => ({
          id: p.id,
          user_id: userId,
          name: p.name,
          provider: p.provider,
          model: p.model,
          api_key: p.apiKey,
          system_prompt: p.systemPrompt,
          autonomous: p.autonomous,
          updated_at: new Date().toISOString(),
        }))
      );
    }
  } catch (e) {
    console.error('Failed to push agent profiles:', e);
  }
}
