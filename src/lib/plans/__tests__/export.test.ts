// src/lib/plans/__tests__/export.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SUBJECT = {
  id: '7e9c1bb6-2f3e-4a1b-9c8d-1234567890ab',
  userId: 'u1',
  projectName: 'Live chat',
  fileName: 'etapa-2.md',
  content: '',
  currentVersionId: '11111111-1111-4111-9111-111111111111',
  createdAt: '',
  updatedAt: '',
};

const VERSION_CURRENT = {
  id: '11111111-1111-4111-9111-111111111111',
  subjectId: SUBJECT.id,
  userId: 'u1',
  contentMarkdown: '# Current\n\nbody',
  parentVersionId: '00000000-0000-4000-9000-000000000000',
  source: 'user' as const,
  sourceActor: null,
  label: null,
  createdAt: '2026-05-09T12:00:00Z',
};

vi.mock('@/stores/subject-versions-store', () => ({
  useSubjectVersionsStore: {
    getState: () => ({
      currentSubjectId: SUBJECT.id,
      versions: [VERSION_CURRENT],
      previewVersionId: null,
    }),
  },
}));

vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      selectedSubjectRow: () => SUBJECT,
    }),
  },
}));

const { save, writeTextFile, mkdir, exists } = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue('C:/Users/Test/exports/live-chat-etapa-2-111111.md'),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile, mkdir, exists,
  BaseDirectory: { AppLocalData: 'AppLocalData' },
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  tryAccountScopedPath: (rel: string) => `notter-ai/u1/${rel}`,
}));

import { exportCurrentVersion } from '@/lib/plans/export';
import { parsePlanMarkdown } from '@/lib/plans/frontmatter';

describe('exportCurrentVersion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a file with frontmatter that round-trips through the parser', async () => {
    const result = await exportCurrentVersion();
    expect(result.cancelled).toBe(false);
    if (!result.cancelled) {
      expect(result.path).toBeTruthy();
    }
    expect(writeTextFile).toHaveBeenCalled();
    const written = (writeTextFile.mock.calls[0] as any)[1] as string;
    const parsed = parsePlanMarkdown(written);
    expect(parsed.frontmatter.subject_id).toBe(SUBJECT.id);
    expect(parsed.frontmatter.version_id).toBe(VERSION_CURRENT.id);
    expect(parsed.frontmatter.title).toBe('Live chat / etapa-2');
    expect(parsed.frontmatter.source).toBe('user');
    expect(parsed.body.trim()).toBe(VERSION_CURRENT.contentMarkdown.trim());
  });

  it('passes a slugified default filename to plugin-dialog.save()', async () => {
    await exportCurrentVersion();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringContaining('live-chat-etapa-2-'),
        filters: expect.arrayContaining([expect.objectContaining({ extensions: ['md'] })]),
      }),
    );
  });

  it('returns { cancelled: true } when the user cancels the save dialog', async () => {
    save.mockResolvedValueOnce(null);
    const result = await exportCurrentVersion();
    expect(result.cancelled).toBe(true);
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
