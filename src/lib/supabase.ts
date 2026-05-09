import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createPerAccountStorage } from '@/lib/accounts/supabase-storage-adapter';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { emit } from '@tauri-apps/api/event';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const storage = createPerAccountStorage(() => getAccountManager().activeAccountId);

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'placeholder',
  {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storage,
    },
  },
);

// M3 hook (stub): every time Supabase rotates the access token (front-end is
// the SOLE refresh owner per spec §6.2), broadcast the new (account, token)
// to anyone listening — in M3 this will be the Rust MCP server. In M1 the
// listener does not exist; the emit is a documented contract, not active code.
supabase.auth.onAuthStateChange((event, session) => {
  if (event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') return;
  const accountId = getAccountManager().activeAccountId;
  if (!accountId || !session?.access_token) return;
  void emit('mcp:account-token-refreshed', {
    accountId,
    accessToken: session.access_token,
    expiresAt: session.expires_at,
  });
});
