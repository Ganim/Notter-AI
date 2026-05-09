// src/lib/accounts/__tests__/supabase-storage-adapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPerAccountStorage, clearPendingStorage, PENDING_NAMESPACE } from '@/lib/accounts/supabase-storage-adapter';

beforeEach(() => {
  localStorage.clear();
});

describe('createPerAccountStorage', () => {
  it('namespaces keys with the current active account id', () => {
    let active: string | null = 'u1';
    const adapter = createPerAccountStorage(() => active);
    adapter.setItem('sb-auth-token', 'session-1');
    expect(localStorage.getItem('notter:u1:sb-auth-token')).toBe('session-1');
    expect(adapter.getItem('sb-auth-token')).toBe('session-1');
  });

  it('falls back to the __pending__ namespace when no account is active (PKCE pre-signin)', () => {
    const adapter = createPerAccountStorage(() => null);
    adapter.setItem('sb-auth-token-code-verifier', 'verifier-xyz');
    expect(localStorage.getItem(`notter:${PENDING_NAMESPACE}:sb-auth-token-code-verifier`)).toBe('verifier-xyz');
    expect(adapter.getItem('sb-auth-token-code-verifier')).toBe('verifier-xyz');
  });

  it('reads from a different namespace after the active account changes', () => {
    let active: string | null = 'u1';
    const adapter = createPerAccountStorage(() => active);
    adapter.setItem('sb-auth-token', 'session-u1');
    active = 'u2';
    expect(adapter.getItem('sb-auth-token')).toBeNull();
    adapter.setItem('sb-auth-token', 'session-u2');
    expect(localStorage.getItem('notter:u2:sb-auth-token')).toBe('session-u2');
  });

  it('removeItem only touches the active namespace', () => {
    let active: string | null = 'u1';
    const adapter = createPerAccountStorage(() => active);
    adapter.setItem('sb-auth-token', 's1');
    active = 'u2';
    adapter.setItem('sb-auth-token', 's2');
    active = 'u1';
    adapter.removeItem('sb-auth-token');
    expect(localStorage.getItem('notter:u1:sb-auth-token')).toBeNull();
    expect(localStorage.getItem('notter:u2:sb-auth-token')).toBe('s2');
  });
});

describe('clearPendingStorage', () => {
  it('removes only keys under the __pending__ namespace', () => {
    localStorage.setItem(`notter:${PENDING_NAMESPACE}:sb-auth-token-code-verifier`, 'v');
    localStorage.setItem(`notter:${PENDING_NAMESPACE}:sb-auth-token`, 's');
    localStorage.setItem('notter:u1:sb-auth-token', 'real-session');
    localStorage.setItem('unrelated', 'stay');
    clearPendingStorage();
    expect(localStorage.getItem(`notter:${PENDING_NAMESPACE}:sb-auth-token-code-verifier`)).toBeNull();
    expect(localStorage.getItem(`notter:${PENDING_NAMESPACE}:sb-auth-token`)).toBeNull();
    expect(localStorage.getItem('notter:u1:sb-auth-token')).toBe('real-session');
    expect(localStorage.getItem('unrelated')).toBe('stay');
  });
});
