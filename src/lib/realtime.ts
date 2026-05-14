import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAppStore } from '@/stores/app-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  fetchProjects, fetchSubjects,
  fetchSubjectVersions, fetchSubjectComments, fetchWorkspaces,
} from '@/lib/sync';
import { subscribeWorkspaceTable } from '@/lib/synced-store';

let channel: RealtimeChannel | null = null;

export function startRealtimeSync(userId: string): void {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();
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

  // Workspace ids the user is a member of. In Plan 1 this equals "workspaces
  // the user owns" because there are no invites yet — the set was just
  // hydrated by WorkspaceManager.bootstrap before we got here.
  const memberWsIds = useWorkspacesStore.getState().workspaces.map((w) => w.id);

  const channelName = `db-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let ch = supabase.channel(channelName);

  // user_preferences stays on the inline payload listener (account-scoped, not workspace).
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

  // Workspace-scoped tables. workspaces filters on `id`, the rest on
  // `workspace_id`.
  ch = subscribeWorkspaceTable(ch, 'workspaces',        memberWsIds, refetchWorkspaces,        'id');
  ch = subscribeWorkspaceTable(ch, 'projects',          memberWsIds, refetchProjects);
  ch = subscribeWorkspaceTable(ch, 'subjects',          memberWsIds, refetchSubjects);
  ch = subscribeWorkspaceTable(ch, 'subject_versions',  memberWsIds, refetchSubjectVersions);
  ch = subscribeWorkspaceTable(ch, 'subject_comments',  memberWsIds, refetchSubjectComments);

  // Membership change listener: filter by user_id of the caller because
  // workspace_members rows for OTHER users in the same workspace are also
  // visible (RLS admits all rows where the caller is a member). We only need
  // to react when the caller's own membership set changes.
  ch = ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'workspace_members', filter: `user_id=eq.${userId}` },
    () => {
      // The user joined or left a workspace. Rebuild the channel so the
      // workspace_id=in.(...) filter list reflects the new set.
      void rebuildRealtimeOnMembershipChange(userId);
    },
  );

  channel = ch.subscribe();
}

export function stopRealtimeSync(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}

/**
 * Re-fetch the caller's workspaces and rebuild the realtime channel so the
 * `workspace_id=in.(...)` filter list reflects newly-joined or left
 * workspaces. Triggered by a workspace_members change event scoped to the
 * caller. No-op for Plan 1 in practice (single-user accounts never receive
 * such events), but the wiring is in place for Plan 2's invites.
 */
async function rebuildRealtimeOnMembershipChange(userId: string): Promise<void> {
  try {
    const rows = await fetchWorkspaces(userId);
    if (!rows) return;
    const prevIds = new Set(useWorkspacesStore.getState().workspaces.map((w) => w.id));
    const nextIds = new Set(rows.map((w) => w.id));
    const same = prevIds.size === nextIds.size && [...prevIds].every((id) => nextIds.has(id));
    useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
    if (!same) {
      // Membership set changed. Stop+start the channel with the new filter list.
      stopRealtimeSync();
      startRealtimeSync(userId);
    }
  } catch (e) {
    console.error('[realtime] rebuildRealtimeOnMembershipChange failed:', e);
  }
}
