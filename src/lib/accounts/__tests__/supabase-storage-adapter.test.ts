// src/lib/accounts/__tests__/supabase-storage-adapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPerAccountStorage } from '@/lib/accounts/supabase-storage-adapter';

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

  it('returns null when no account is active', () => {
    const adapter = createPerAccountStorage(() => null);
    expect(adapter.getItem('sb-auth-token')).toBeNull();
    adapter.setItem('sb-auth-token', 'ignored'); // silently no-ops
    expect(localStorage.getItem('notter:null:sb-auth-token')).toBeNull();
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
