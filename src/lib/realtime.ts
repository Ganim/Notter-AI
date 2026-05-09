import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAppStore } from '@/stores/app-store';
import { useAgentsStore } from '@/stores/agents-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useBoardStore } from '@/stores/board-store';
import { useActionsStore } from '@/stores/actions-store';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  fetchAgentProfiles, fetchProjects, fetchSubjects, fetchBoardTasks, fetchActions,
} from '@/lib/sync';
import { subscribeUserTable } from '@/lib/synced-store';

let channel: RealtimeChannel | null = null;

export function startRealtimeSync(userId: string): void {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();

  const refetchProfiles = async () => {
    const profiles = await fetchAgentProfiles(userId);
    if (profiles.length > 0) useAgentsStore.getState().applyRemoteProfiles(profiles);
  };
  const refetchProjects = async () => {
    const projects = await fetchProjects(userId);
    if (projects) usePlannerStore.getState().applyRemoteProjects(projects);
  };
  const refetchSubjects = async () => {
    const subjects = await fetchSubjects(userId);
    if (subjects) await usePlannerStore.getState().applyRemoteSubjects(subjects);
  };
  const refetchBoardTasks = async () => {
    const tasks = await fetchBoardTasks(userId);
    if (tasks) useBoardStore.getState().applyRemoteTasks(tasks);
  };
  const refetchActions = async () => {
    const actions = await fetchActions(userId);
    if (actions) useActionsStore.getState().applyRemoteActions(actions);
  };

  let ch = supabase.channel('db-sync');
  // user_preferences keeps the inline listener — it consumes payload.new
  // directly (single row per user, no re-fetch), legitimately different.
  ch = ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'user_preferences', filter: `user_id=eq.${userId}` },
    (payload) => {
      const row = payload.new as any;
      if (!row || payload.eventType === 'DELETE') return;
      useAppStore.getState().applyRemotePreferences({
        darkMode: row.dark_mode,
        language: row.language,
        terminalTheme: row.terminal_theme,
        terminalFont: row.terminal_font,
        terminalFontSize: row.terminal_font_size,
        terminalLigatures: row.terminal_ligatures,
      });
    },
  );

  ch = subscribeUserTable(ch, 'agent_profiles', userId, refetchProfiles);
  ch = subscribeUserTable(ch, 'projects',       userId, refetchProjects);
  ch = subscribeUserTable(ch, 'subjects',       userId, refetchSubjects);
  ch = subscribeUserTable(ch, 'board_tasks',    userId, refetchBoardTasks);
  ch = subscribeUserTable(ch, 'actions',        userId, refetchActions);

  channel = ch.subscribe();
}

export function stopRealtimeSync(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}
