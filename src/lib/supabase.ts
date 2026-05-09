import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createPerAccountStorage } from '@/lib/accounts/supabase-storage-adapter';
import { emit } from '@tauri-apps/api/event';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Lazy bind: this module CANNOT statically import account-manager because
// the chain account-manager → realtime → store → auth-store → supabase would
// form a circular dep. The TDZ trips at auth-store's create() factory before
// supabase.ts finishes initializing `isSupabaseConfigured`.
//
// Instead, AccountManager.bootstrap() calls `_bindAccountManager(getter)` to
// wire the active-account lookup. Until then this returns null (no session
// hydration is possible pre-bootstrap anyway, so safe).
let _getActiveAccountId: () => string | null = () => null;
export function _bindAccountManager(getter: () => string | null): void {
  _getActiveAccountId = getter;
}

const storage = createPerAccountStorage(() => _getActiveAccountId());

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
  const accountId = _getActiveAccountId();
  if (!accountId || !session?.access_token) return;
  void emit('mcp:account-token-refreshed', {
    accountId,
    accessToken: session.access_token,
    expiresAt: session.expires_at,
  });
});
