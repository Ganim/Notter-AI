import { create } from 'zustand';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { secureGet, accountKeys } from '@/lib/accounts/secure-store';
import { clearPendingStorage } from '@/lib/accounts/supabase-storage-adapter';
import {
  fetchPreferences, pushPreferences,
  fetchAgentProfiles, pushAgentProfiles,
  fetchProjects, pushProjects,
  fetchSubjects,
  fetchBoardTasks, pushBoardTasks,
  fetchActions, pushActions,
  fetchWorkspaces,
} from '@/lib/sync';
import { useAppStore } from '@/stores/app-store';
import { useAgentsStore } from '@/stores/agents-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useBoardStore } from '@/stores/board-store';
import { useActionsStore } from '@/stores/actions-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { startRealtimeSync, stopRealtimeSync } from '@/lib/realtime';
import { resetAllStores } from '@/lib/accounts/store-registry';
import { notifyMcpAccountTokenChanged, notifyMcpAccountRemoved } from '@/lib/mcp';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  configured: boolean;

  initialize: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<{ error?: string }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error?: string }>;
  signInWithOAuth: (provider: 'google' | 'github') => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

async function syncOnLogin(userId: string) {
  try {
    // Workspaces — must boot FIRST. Projects fetch filters by workspace_id and
    // PlannerStore derives its visible projects from currentWorkspaceId, so the
    // workspace context has to land before any project/subject hydration runs.
    // bootstrap() handles the lazy default workspace if the user has none.
    try {
      await getWorkspaceManager().bootstrap();
      const remoteWs = await fetchWorkspaces(userId);
      if (remoteWs) useWorkspacesStore.getState().applyRemoteWorkspaces(remoteWs);
      const currentId = getWorkspaceManager().currentWorkspaceId;
      if (currentId) useWorkspacesStore.getState().setCurrentWorkspaceId(currentId);

      // fs-migration-v2: move <accountId>/{cache,exports} → <accountId>/<defaultWorkspaceId>/...
      // Sentinel-gated, idempotent. Failures are logged + toasted but do NOT block startup.
      if (currentId) {
        const mgr = getAccountManager();
        if (mgr.activeAccountId) {
          const { migrateAccountToWorkspacesIfNeeded } = await import('@/lib/workspaces/fs-migration-v2');
          try {
            const r = await migrateAccountToWorkspacesIfNeeded(mgr.activeAccountId, currentId);
            if (!r.skipped && r.failed.length > 0) {
              const { toast } = await import('sonner');
              toast.warning(
                `Workspaces migration partial — ${r.failed.length} item(s) could not be moved. See logs.`,
                { duration: 10_000 },
              );
              console.warn('[auth] fs-migration-v2 failures:', r.failed);
            }
          } catch (e) {
            console.error('[auth] fs-migration-v2 threw:', e);
          }
        }
      }
    } catch (e) {
      console.error('[auth] workspaces bootstrap failed:', e);
    }

    // Preferences
    const remotePrefs = await fetchPreferences(userId);
    if (remotePrefs) {
      useAppStore.getState().applyRemotePreferences(remotePrefs);
    } else {
      const localPrefs = useAppStore.getState().getPreferences();
      await pushPreferences(userId, localPrefs);
    }

    // Agent profiles
    const remoteProfiles = await fetchAgentProfiles(userId);
    if (remoteProfiles.length > 0) {
      useAgentsStore.getState().applyRemoteProfiles(remoteProfiles);
    } else {
      const localProfiles = useAgentsStore.getState().profiles;
      await pushAgentProfiles(userId, localProfiles);
    }

    // Projects
    const remoteProjects = await fetchProjects(userId);
    if (remoteProjects) {
      usePlannerStore.getState().applyRemoteProjects(remoteProjects);
    } else {
      const localProjects = usePlannerStore.getState().projects;
      if (localProjects.length > 0) await pushProjects(userId, localProjects);
    }

    // Subjects (markdown notes)
    const remoteSubjects = await fetchSubjects(userId);
    if (remoteSubjects) {
      await usePlannerStore.getState().applyRemoteSubjects(remoteSubjects);
    } else {
      await usePlannerStore.getState().pushAllSubjects(userId);
    }

    // Board tasks
    const remoteTasks = await fetchBoardTasks(userId);
    if (remoteTasks) {
      useBoardStore.getState().applyRemoteTasks(remoteTasks);
    } else {
      const localTasks = useBoardStore.getState().tasks;
      if (localTasks.length > 0) await pushBoardTasks(userId, localTasks);
    }

    // Actions
    const remoteActions = await fetchActions(userId);
    if (remoteActions) {
      useActionsStore.getState().applyRemoteActions(remoteActions);
    } else {
      const localActions = useActionsStore.getState().actions;
      if (localActions.length > 0) await pushActions(userId, localActions);
    }
  } catch (e) {
    console.error('Sync on login failed:', e);
  }
}

export { syncOnLogin };

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  loading: true,
  configured: isSupabaseConfigured,

  initialize: async () => {
    if (!isSupabaseConfigured) {
      set({ loading: false });
      return;
    }

    // NOTE: AccountManager.bootstrap() MUST be awaited in App.tsx BEFORE
    // initialize() is called (Task E4). Do NOT call bootstrap() here.
    try {
      const mgr = getAccountManager();
      const activeId = mgr.activeAccountId;

      if (activeId !== null) {
        // Storage adapter resolves to the active account's namespace.
        const { data: { session } } = await supabase.auth.getSession();

        if (session) {
          set({ session, user: session.user, loading: false });
          syncOnLogin(session.user.id);
          startRealtimeSync(session.user.id);
          // Push the just-hydrated access token to the Rust MCP server.
          // onAuthStateChange does NOT fire for the initial getSession() result,
          // so this is the only place to push tokens on cold-start.
          if (session.access_token) {
            void notifyMcpAccountTokenChanged(
              session.user.id,
              session.access_token,
              session.expires_at ?? 0,
            );
          }
        } else {
          // Try to refresh using secure-store refresh token.
          const rt = await secureGet(accountKeys.refreshToken(activeId));
          if (rt) {
            const { data: { session: refreshed } } = await supabase.auth.setSession({
              access_token: '',
              refresh_token: rt,
            });
            set({
              session: refreshed,
              user: refreshed?.user ?? null,
              loading: false,
            });
            if (refreshed?.user) {
              syncOnLogin(refreshed.user.id);
              startRealtimeSync(refreshed.user.id);
              if (refreshed.access_token) {
                void notifyMcpAccountTokenChanged(
                  refreshed.user.id,
                  refreshed.access_token,
                  refreshed.expires_at ?? 0,
                );
              }
            }
          } else {
            set({ loading: false });
          }
        }
      } else {
        set({ loading: false });
      }

      supabase.auth.onAuthStateChange((event, session) => {
        set({
          session,
          user: session?.user ?? null,
        });
        if (event === 'SIGNED_IN' && session?.user) {
          syncOnLogin(session.user.id);
          startRealtimeSync(session.user.id);
        }
        if (
          (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') &&
          session?.user &&
          session.access_token
        ) {
          // Push the rotated/initial access token to the Rust MCP server.
          // SIGNED_OUT removal is handled in signOut() because we need the
          // previous user id, which this closure can't reliably capture.
          void notifyMcpAccountTokenChanged(
            session.user.id,
            session.access_token,
            session.expires_at ?? 0,
          );
        }
        if (event === 'SIGNED_OUT') {
          stopRealtimeSync();
        }
      });
    } catch (e) {
      console.error('Auth initialization failed:', e);
      set({ loading: false });
    }
  },

  signInWithEmail: async (email, password) => {
    if (!isSupabaseConfigured) return { error: 'not_configured' };

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.includes('Invalid login credentials')) return { error: 'invalid_credentials' };
      return { error: 'generic' };
    }
    if (!data.session?.user || !data.session.refresh_token) return { error: 'generic' };

    const mgr = getAccountManager();
    const existing = mgr.get(data.session.user.id);
    if (!existing) {
      await mgr.add({
        id: data.session.user.id,
        email: data.session.user.email ?? email,
        displayName: (data.session.user.user_metadata?.display_name as string | undefined) ?? null,
        refreshToken: data.session.refresh_token,
      });
    }
    await mgr.setActiveAccountId(data.session.user.id);

    // CRITICAL: re-persist under the now-active namespace. The signInWithPassword
    // call above wrote the session under the OLD (null) namespace. setSession here
    // ensures it lands in the correct account-scoped storage key so it survives app restart.
    await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    clearPendingStorage();

    // Push the fresh access token to Rust MCP. setSession above triggers a
    // SIGNED_IN event on the listener too, but doing it here guarantees the
    // token reaches Rust even if the listener race loses to a fast MCP request.
    void notifyMcpAccountTokenChanged(
      data.session.user.id,
      data.session.access_token,
      data.session.expires_at ?? 0,
    );

    return {};
  },

  signUpWithEmail: async (email, password) => {
    if (!isSupabaseConfigured) return { error: 'not_configured' };

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      if (error.message.includes('already registered')) return { error: 'email_taken' };
      return { error: 'generic' };
    }

    // data.session is null when email confirmation is required (most prod setups).
    // Only register the account if we get a live session (email confirmation disabled).
    if (data.session?.user && data.session.refresh_token) {
      const mgr = getAccountManager();
      const existing = mgr.get(data.session.user.id);
      if (!existing) {
        await mgr.add({
          id: data.session.user.id,
          email: data.session.user.email ?? email,
          displayName: (data.session.user.user_metadata?.display_name as string | undefined) ?? null,
          refreshToken: data.session.refresh_token,
        });
      }
      await mgr.setActiveAccountId(data.session.user.id);

      // CRITICAL: re-persist under the now-active namespace (same reason as signInWithEmail).
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      void notifyMcpAccountTokenChanged(
        data.session.user.id,
        data.session.access_token,
        data.session.expires_at ?? 0,
      );
    }

    return {};
  },

  signInWithOAuth: async (provider) => {
    if (!isSupabaseConfigured) return { error: 'not_configured' };

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: 'notterai://auth/callback',
        skipBrowserRedirect: true,
      },
    });
    if (error) return { error: 'generic' };
    if (data?.url) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(data.url);
    }
    return {};
  },

  signOut: async () => {
    if (!isSupabaseConfigured) return;
    stopRealtimeSync();
    // Drop the WorkspaceManager singleton state — next sign-in will rebuild it.
    getWorkspaceManager().reset();
    // Capture the user id BEFORE signOut clears the session — the
    // onAuthStateChange listener can't reliably get this.
    const previousId = (await supabase.auth.getSession()).data.session?.user?.id;
    await supabase.auth.signOut();
    if (previousId) await notifyMcpAccountRemoved(previousId);
    await getAccountManager().setActiveAccountId(null);
    set({ user: null, session: null });
    resetAllStores();
  },
}));
