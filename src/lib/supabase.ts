import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createPerAccountStorage } from '@/lib/accounts/supabase-storage-adapter';

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
