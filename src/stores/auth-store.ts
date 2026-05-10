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
} from '@/lib/sync';
import { useAppStore } from '@/stores/app-store';
import { useAgentsStore } from '@/stores/agents-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useBoardStore } from '@/stores/board-store';
import { useActionsStore } from '@/stores/actions-store';
import { usePlanStore } from '@/stores/plan-store';
import { migrateSubjectsToPlans } from '@/lib/plans/migration';
import { startRealtimeSync, stopRealtimeSync } from '@/lib/realtime';
import { resetAllStores } from '@/lib/accounts/store-registry';
import { toast } from 'sonner';

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

    // Subjects → plans one-shot migration. Must run AFTER the session is
    // established (we are inside syncOnLogin, which only runs after
    // setSession resolves) — running this from App.tsx before initialize()
    // would query Supabase without auth and silently no-op under RLS.
    // The function is idempotent (sentinel-gated), so re-runs are safe.
    try {
      const planMigration = await migrateSubjectsToPlans(userId);
      if (!planMigration.skipped && planMigration.failed.length > 0) {
        toast.warning(
          `Plans migration: ${planMigration.migrated} migrated, ${planMigration.failed.length} failed. See logs.`,
          { duration: 10_000 },
        );
        console.warn('[auth] plans migration failures:', planMigration.failed);
      }
    } catch (e) {
      console.error('[auth] plans migration threw:', e);
    }

    // Plans (load from Supabase + populate local cache)
    await usePlanStore.getState().load(userId);
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
    await supabase.auth.signOut();
    await getAccountManager().setActiveAccountId(null);
    set({ user: null, session: null });
    resetAllStores();
  },
}));
