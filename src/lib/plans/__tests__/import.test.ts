// src/lib/plans/__tests__/import.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SUBJECT_A = {
  id: '7e9c1bb6-2f3e-4a1b-9c8d-1234567890ab',
  userId: 'u1',
  projectName: 'Live chat',
  fileName: 'etapa-2.md',
  content: '# old',
  currentVersionId: '11111111-1111-4111-9111-111111111111',
  createdAt: '',
  updatedAt: '',
};

const snapshotCurrent = vi.fn().mockResolvedValue({
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
});
const loadForSubject = vi.fn().mockResolvedValue(undefined);

vi.mock('@/stores/subject-versions-store', () => ({
  useSubjectVersionsStore: {
    getState: () => ({
      currentSubjectId: SUBJECT_A.id,
      snapshotCurrent,
      loadForSubject,
    }),
  },
}));

const createProject = vi.fn().mockResolvedValue(undefined);
const createSubject = vi.fn().mockResolvedValue(undefined);
const saveSubjectContent = vi.fn().mockResolvedValue(undefined);

vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      subjectRows: [SUBJECT_A],
      projects: [{ name: 'Live chat', path: '' }],
      createProject,
      createSubject,
      saveSubjectContent,
    }),
  },
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn().mockResolvedValue(''),
  BaseDirectory: { AppLocalData: 'AppLocalData' },
}));

import { importMarkdownText } from '@/lib/plans/import';
import { stringifyPlanMarkdown } from '@/lib/plans/frontmatter';

const VALID_FM = {
  subject_id: SUBJECT_A.id,
  version_id: 'b2b2b2b2-b2b2-4b2b-b2b2-b2b2b2b2b2b2',
  parent_version_id: SUBJECT_A.currentVersionId,
  title: 'Live chat / Etapa 2',
  source: 'user' as const,
  source_actor: null,
  exported_at: '2026-05-10T18:30:00Z',
};

describe('importMarkdownText — case A (subject_id matches existing row)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls snapshotCurrent with source=import and the imported body', async () => {
    const text = stringifyPlanMarkdown({ frontmatter: VALID_FM, body: '# new content' });
    const result = await importMarkdownText(text, 'etapa-2.md');
    expect(result.kind).toBe('version_added');
    if (result.kind === 'version_added') {
      expect(result.subjectId).toBe(SUBJECT_A.id);
    }
    expect(snapshotCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'import',
        contentMarkdown: expect.stringContaining('new content'),
      }),
    );
  });

  it('threads frontmatter.parent_version_id into the snapshot args', async () => {
    const text = stringifyPlanMarkdown({ frontmatter: VALID_FM, body: 'body' });
    await importMarkdownText(text, 'etapa-2.md');
    expect(snapshotCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ parentVersionId: VALID_FM.parent_version_id }),
    );
  });
});

describe('importMarkdownText — error paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects with the FrontmatterError code on malformed YAML', async () => {
    const text = `---\nsubject_id: [unclosed\n---\nbody`;
    await expect(importMarkdownText(text, 'x.md')).rejects.toThrow(/PARSE_ERROR|malformed/);
  });

  it('rejects with MISSING_FIELD when required key absent', async () => {
    const text = `---\ntitle: x\nsource: user\nexported_at: 2026-05-10T18:30:00Z\n---\nbody`;
    await expect(importMarkdownText(text, 'x.md')).rejects.toThrow();
  });
});
