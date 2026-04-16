import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAppStore } from '@/stores/app-store';
import { useAgentsStore } from '@/stores/agents-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useBoardStore } from '@/stores/board-store';
import { useActionsStore } from '@/stores/actions-store';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { AgentProfile, Project, BoardTask } from '@/types';
import type { Action } from '@/types/actions';
import type { UserPreferences } from '@/lib/sync';

let channel: RealtimeChannel | null = null;

export function startRealtimeSync(userId: string): void {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();

  channel = supabase
    .channel('db-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'user_preferences', filter: `user_id=eq.${userId}` },
      (payload) => {
        const row = payload.new as any;
        if (!row || payload.eventType === 'DELETE') return;
        const prefs: UserPreferences = {
          darkMode: row.dark_mode,
          language: row.language,
          terminalTheme: row.terminal_theme,
          terminalFont: row.terminal_font,
          terminalFontSize: row.terminal_font_size,
          terminalLigatures: row.terminal_ligatures,
        };
        useAppStore.getState().applyRemotePreferences(prefs);
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'agent_profiles', filter: `user_id=eq.${userId}` },
      async () => {
        // Re-fetch all profiles on any change (insert/update/delete)
        const { data } = await supabase
          .from('agent_profiles')
          .select('*')
          .eq('user_id', userId);
        if (data && data.length > 0) {
          const profiles: AgentProfile[] = data.map((row: any) => ({
            id: row.id,
            name: row.name,
            provider: row.provider,
            model: row.model || '',
            apiKey: row.api_key || '',
            systemPrompt: row.system_prompt || '',
            autonomous: row.autonomous || false,
          }));
          useAgentsStore.getState().applyRemoteProfiles(profiles);
        }
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'projects', filter: `user_id=eq.${userId}` },
      async () => {
        const { data } = await supabase
          .from('projects')
          .select('*')
          .eq('user_id', userId);
        if (data) {
          const projects: Project[] = data.map((row: any) => ({
            name: row.name,
            path: row.path,
          }));
          usePlannerStore.getState().applyRemoteProjects(projects);
        }
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'subjects', filter: `user_id=eq.${userId}` },
      async () => {
        const { data } = await supabase
          .from('subjects')
          .select('*')
          .eq('user_id', userId);
        if (data) {
          const subjects = data.map((row: any) => ({
            projectName: row.project_name,
            fileName: row.file_name,
            content: row.content,
          }));
          await usePlannerStore.getState().applyRemoteSubjects(subjects);
        }
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_tasks', filter: `user_id=eq.${userId}` },
      async () => {
        const { data } = await supabase
          .from('board_tasks')
          .select('*')
          .eq('user_id', userId);
        if (data) {
          const tasks: BoardTask[] = data.map((row: any) => ({
            id: row.id,
            projectName: row.project_name,
            subjectName: row.subject_name,
            title: row.title,
            description: row.description,
            status: row.status,
            priority: row.priority,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            messages: row.messages ?? [],
          }));
          useBoardStore.getState().applyRemoteTasks(tasks);
        }
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'actions', filter: `user_id=eq.${userId}` },
      async () => {
        const { data } = await supabase
          .from('actions')
          .select('*')
          .eq('user_id', userId);
        if (data) {
          const actions: Action[] = data.map((row: any) => row.data as Action);
          useActionsStore.getState().applyRemoteActions(actions);
        }
      },
    )
    .subscribe();
}

export function stopRealtimeSync(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}
