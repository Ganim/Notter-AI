import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAppStore } from '@/stores/app-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useActionsStore } from '@/stores/actions-store';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  fetchProjects, fetchSubjects, fetchActions,
  fetchSubjectVersions, fetchSubjectComments, fetchWorkspaces,
} from '@/lib/sync';
import { subscribeUserTable } from '@/lib/synced-store';

let channel: RealtimeChannel | null = null;

export function startRealtimeSync(userId: string): void {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();
  // Sweep any lingering db-sync* channels from prior calls (HMR, double-mount,
  // or initialize() races). Each call uses a unique name so collisions are
  // impossible going forward, but old channels still consume realtime quota.
  for (const c of supabase.getChannels()) {
    if (c.topic.includes('db-sync')) {
      supabase.removeChannel(c);
    }
  }

  const refetchProjects = async () => {
    const projects = await fetchProjects(userId);
    if (projects) usePlannerStore.getState().applyRemoteProjects(projects);
  };
  const refetchSubjects = async () => {
    const subjects = await fetchSubjects(userId);
    if (subjects) await usePlannerStore.getState().applyRemoteSubjects(subjects);
  };
  const refetchActions = async () => {
    const actions = await fetchActions(userId);
    if (actions) useActionsStore.getState().applyRemoteActions(actions);
  };
  const refetchSubjectVersions = async () => {
    const currentSubjectId = useSubjectVersionsStore.getState().currentSubjectId;
    if (!currentSubjectId) return;
    const versions = await fetchSubjectVersions(currentSubjectId);
    if (versions) useSubjectVersionsStore.getState().applyRemoteVersions(versions);
  };
  const refetchSubjectComments = async () => {
    const currentSubjectId = useSubjectVersionsStore.getState().currentSubjectId;
    if (!currentSubjectId) return;
    const comments = await fetchSubjectComments(currentSubjectId);
    if (comments) useSubjectVersionsStore.getState().applyRemoteComments(comments);
  };
  const refetchWorkspaces = async () => {
    const rows = await fetchWorkspaces(userId);
    if (rows) useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
  };

  // Unique channel name per call. supabase.channel(name) returns the SAME
  // object for the same name, even after removeChannel(); calling .on() on
  // an already-subscribed channel throws. A fresh name guarantees a fresh
  // channel and side-steps HMR / double-mount races entirely.
  const channelName = `db-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let ch = supabase.channel(channelName);
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
      });
    },
  );

  ch = subscribeUserTable(ch, 'workspaces',        userId, refetchWorkspaces);
  ch = subscribeUserTable(ch, 'projects',          userId, refetchProjects);
  ch = subscribeUserTable(ch, 'subjects',          userId, refetchSubjects);
  ch = subscribeUserTable(ch, 'subject_versions',  userId, refetchSubjectVersions);
  ch = subscribeUserTable(ch, 'subject_comments',  userId, refetchSubjectComments);
  ch = subscribeUserTable(ch, 'actions',           userId, refetchActions);

  channel = ch.subscribe();
}

export function stopRealtimeSync(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}
