import { create } from 'zustand';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
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
import { startRealtimeSync, stopRealtimeSync } from '@/lib/realtime';

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

    try {
      const { data: { session } } = await supabase.auth.getSession();
      set({
        session,
        user: session?.user ?? null,
        loading: false,
      });
      if (session?.user) {
        syncOnLogin(session.user.id);
        startRealtimeSync(session.user.id);
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

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.includes('Invalid login credentials')) {
        return { error: 'invalid_credentials' };
      }
      return { error: 'generic' };
    }
    return {};
  },

  signUpWithEmail: async (email, password) => {
    if (!isSupabaseConfigured) return { error: 'not_configured' };

    const { error } = await supabase.auth.signUp({ email, password });
    if (error) {
      if (error.message.includes('already registered')) {
        return { error: 'email_taken' };
      }
      return { error: 'generic' };
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
    set({ user: null, session: null });
  },
}));
