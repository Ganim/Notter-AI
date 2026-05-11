// src/lib/mcp/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  notifyMcpAccountTokenChanged,
  notifyMcpAccountRemoved,
  pushMcpSupabaseConfig,
  notifyMcpAccountRegistered,
  readMcpConfigForAccount,
} from '@/lib/mcp';

beforeEach(() => {
  invokeMock.mockReset();
  // Silence the console.warn calls from the swallow-error paths so vitest 4's
  // stderr capture doesn't mark those tests as failed.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('mcp glue', () => {
  it('notifyMcpAccountTokenChanged forwards to mcp_update_account_token', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountTokenChanged('acc1', 'tok1', 9999);
    expect(invokeMock).toHaveBeenCalledWith('mcp_update_account_token', {
      args: { accountId: 'acc1', accessToken: 'tok1', expiresAt: 9999 },
    });
  });

  it('swallows errors from invoke', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyMcpAccountTokenChanged('acc1', 'tok1', 9999),
    ).resolves.toBeUndefined();
  });

  it('notifyMcpAccountRemoved forwards to mcp_remove_account_token', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountRemoved('acc1');
    expect(invokeMock).toHaveBeenCalledWith('mcp_remove_account_token', { accountId: 'acc1' });
  });

  it('notifyMcpAccountRegistered forwards to mcp_register_bearer with the camelCase args envelope', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountRegistered('acc1', 'tok-bearer');
    expect(invokeMock).toHaveBeenCalledWith('mcp_register_bearer', {
      args: { accountId: 'acc1', bearerToken: 'tok-bearer' },
    });
  });

  it('pushMcpSupabaseConfig forwards to mcp_set_supabase_config', async () => {
    invokeMock.mockResolvedValue(undefined);
    await pushMcpSupabaseConfig('https://x.supabase.co', 'anon-key-xyz');
    expect(invokeMock).toHaveBeenCalledWith('mcp_set_supabase_config', {
      args: { url: 'https://x.supabase.co', anonKey: 'anon-key-xyz' },
    });
  });

  it('readMcpConfigForAccount returns null on error', async () => {
    invokeMock.mockRejectedValue(new Error('not found'));
    expect(await readMcpConfigForAccount('acc1')).toBeNull();
  });

  it('readMcpConfigForAccount forwards args + returns config on success', async () => {
    invokeMock.mockResolvedValue({
      url: 'http://127.0.0.1:1234/mcp',
      bearer_token: 'tok',
      account_id: 'acc1',
      generated_at: '2026-05-10T00:00:00Z',
    });
    const cfg = await readMcpConfigForAccount('acc1');
    expect(invokeMock).toHaveBeenCalledWith('mcp_read_account_config', {
      args: { accountId: 'acc1' },
    });
    expect(cfg?.bearer_token).toBe('tok');
  });
});
