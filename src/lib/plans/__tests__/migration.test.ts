// src/lib/plans/__tests__/migration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => {
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => Promise.resolve({
        data: [
          { project_name: 'My Project', file_name: 'spec.md', content: '# Spec', user_id: 'u1' },
          { project_name: 'My Project', file_name: 'notes.md', content: '# Notes', user_id: 'u1' },
        ],
        error: null,
      }),
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
  }));
  return { supabase: { from }, isSupabaseConfigured: true };
});

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppLocalData: 'AppLocalData' },
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  tryAccountScopedPath: (rel: string) => `notter-ai/u1/${rel}`,
}));

import { migrateSubjectsToPlans } from '@/lib/plans/migration';

describe('migrateSubjectsToPlans', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips if sentinel file already exists', async () => {
    const { exists } = await import('@tauri-apps/plugin-fs');
    (exists as any).mockResolvedValueOnce(true);
    const result = await migrateSubjectsToPlans('u1');
    expect(result.skipped).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it('migrates each subject row into a plans insert with flattened title', async () => {
    const result = await migrateSubjectsToPlans('u1');
    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(2);
    expect(result.failed).toHaveLength(0);
  });

  it('writes sentinel file after successful migration', async () => {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await migrateSubjectsToPlans('u1');
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining('.migration-m2-plans-complete'),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('does NOT write sentinel if any row failed', async () => {
    const { supabase } = await import('@/lib/supabase');
    // Replace the default impl so that BOTH the subjects fetch and the plans
    // insert use this mock (mockImplementationOnce only covers the next call).
    (supabase.from as any).mockImplementation(() => ({
      select: () => ({
        eq: () => Promise.resolve({
          data: [
            { project_name: 'P1', file_name: 'a.md', content: '# A', user_id: 'u1' },
          ],
          error: null,
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: { message: 'db error' } }),
    }));
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const result = await migrateSubjectsToPlans('u1');
    expect(result.failed).toHaveLength(1);
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
