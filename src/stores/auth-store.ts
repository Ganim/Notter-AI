import { create } from 'zustand';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import { fetchPreferences, pushPreferences, fetchAgentProfiles, pushAgentProfiles } from '@/lib/sync';
import { useAppStore } from '@/stores/app-store';
import { useAgentsStore } from '@/stores/agents-store';

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
    const remotePrefs = await fetchPreferences(userId);
    if (remotePrefs) {
      useAppStore.getState().applyRemotePreferences(remotePrefs);
    } else {
      const localPrefs = useAppStore.getState().getPreferences();
      await pushPreferences(userId, localPrefs);
    }

    const remoteProfiles = await fetchAgentProfiles(userId);
    if (remoteProfiles.length > 0) {
      useAgentsStore.getState().applyRemoteProfiles(remoteProfiles);
    } else {
      const localProfiles = useAgentsStore.getState().profiles;
      await pushAgentProfiles(userId, localProfiles);
    }
  } catch (e) {
    console.error('Sync on login failed:', e);
  }
}

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
      }

      supabase.auth.onAuthStateChange((event, session) => {
        set({
          session,
          user: session?.user ?? null,
        });
        if (event === 'SIGNED_IN' && session?.user) {
          syncOnLogin(session.user.id);
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

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      return { error: 'generic' };
    }
    return {};
  },

  signOut: async () => {
    if (!isSupabaseConfigured) return;
    await supabase.auth.signOut();
    set({ user: null, session: null });
  },
}));
