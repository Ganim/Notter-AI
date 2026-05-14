import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateUser = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      updateUser: (...a: any[]) => updateUser(...a),
      getUser: () => getUser(),
    }
  }
}));

import { readAccountSettings, writeAccountSettings, migrateFromLocalStorageOnce } from '../account-settings';

describe('account-settings', () => {
  beforeEach(() => {
    updateUser.mockReset();
    getUser.mockReset();
    localStorage.clear();
  });

  it('readAccountSettings returns notter blob from user_metadata', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: { notter: { theme: 'dark', language: 'en-US' } } } } });
    const s = await readAccountSettings();
    expect(s.theme).toBe('dark');
    expect(s.language).toBe('en-US');
  });

  it('readAccountSettings applies defaults when notter blob missing', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: {} } } });
    const s = await readAccountSettings();
    expect(s.theme).toBe('system');
    expect(s.language).toBe('pt-BR');
    expect(s.update_settings.auto_check).toBe(true);
  });

  it('writeAccountSettings calls auth.updateUser with merged notter blob', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: { notter: { theme: 'light' } } } } });
    updateUser.mockResolvedValue({});
    await writeAccountSettings({ language: 'en-US' });
    expect(updateUser).toHaveBeenCalledWith({
      data: { notter: expect.objectContaining({ theme: 'light', language: 'en-US' }) }
    });
  });

  it('migrateFromLocalStorageOnce copies legacy keys when notter blob absent', async () => {
    localStorage.setItem('notter-theme', 'dark');
    localStorage.setItem('notter-language', 'en-US');
    getUser.mockResolvedValue({ data: { user: { user_metadata: {} } } });
    updateUser.mockResolvedValue({});
    await migrateFromLocalStorageOnce();
    expect(updateUser).toHaveBeenCalled();
    const call = updateUser.mock.calls[0][0];
    expect(call.data.notter.theme).toBe('dark');
    expect(call.data.notter.language).toBe('en-US');
  });

  it('migrateFromLocalStorageOnce is a no-op when notter blob already exists', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: { notter: { theme: 'system' } } } } });
    await migrateFromLocalStorageOnce();
    expect(updateUser).not.toHaveBeenCalled();
  });
});
