import { describe, it, expect, vi, beforeEach } from 'vitest';
import { secureSet, secureGet, secureDelete } from '@/lib/accounts/secure-store';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => invokeMock(...args) }));

beforeEach(() => invokeMock.mockReset());

describe('secureSet', () => {
  it('forwards to secure_set Tauri command', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await secureSet('notter:account:abc:refresh_token', 'rt-xyz');
    expect(invokeMock).toHaveBeenCalledWith('secure_set', {
      key: 'notter:account:abc:refresh_token',
      value: 'rt-xyz',
    });
  });
});

describe('secureGet', () => {
  it('returns null when value is absent', async () => {
    invokeMock.mockResolvedValueOnce({ key: 'k', value: null });
    expect(await secureGet('k')).toBeNull();
  });
  it('returns the value when present', async () => {
    invokeMock.mockResolvedValueOnce({ key: 'k', value: 'v' });
    expect(await secureGet('k')).toBe('v');
  });
});

describe('secureDelete', () => {
  it('forwards to secure_delete', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await secureDelete('k');
    expect(invokeMock).toHaveBeenCalledWith('secure_delete', { key: 'k' });
  });
});
