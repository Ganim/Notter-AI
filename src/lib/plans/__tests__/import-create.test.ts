// src/lib/plans/__tests__/import-create.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const snapshotCurrent = vi.fn().mockResolvedValue({ id: 'v1' });
const loadForSubject = vi.fn().mockResolvedValue(undefined);

// subjectRows starts empty; createSubject simulates the row arriving via realtime.
let subjectRows: any[] = [];
let projects: any[] = [];

vi.mock('@/stores/subject-versions-store', () => ({
  useSubjectVersionsStore: {
    getState: () => ({
      currentSubjectId: null,
      snapshotCurrent,
      loadForSubject,
    }),
  },
}));

const createProject = vi.fn().mockImplementation(async (name: string) => {
  projects.push({ name, path: '' });
});
const createSubject = vi.fn().mockImplementation(async (proj: string, file: string) => {
  // Simulate the row appearing post-create (the real planner-store push is
  // debounced; the test fast-forwards by injecting it synchronously).
  subjectRows.push({
    id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
    userId: 'u1', projectName: proj, fileName: file, content: '',
    currentVersionId: null, createdAt: '', updatedAt: '',
  });
});
const saveSubjectContent = vi.fn().mockResolvedValue(undefined);

vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      get subjectRows() { return subjectRows; },
      get projects() { return projects; },
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

const FM = {
  subject_id: 'unknown1-2222-4222-9222-222222222222',
  version_id: 'b2b2b2b2-b2b2-4b2b-b2b2-b2b2b2b2b2b2',
  parent_version_id: null,
  title: 'My Project / new-note.md',
  source: 'ai' as const,
  source_actor: 'codex',
  exported_at: '2026-05-10T18:30:00Z',
};

describe('importMarkdownText — case B (no matching subject)', () => {
  beforeEach(() => {
    subjectRows = [];
    projects = [];
    vi.clearAllMocks();
  });

  it('creates project + subject + snapshot when title has slash separator', async () => {
    const text = stringifyPlanMarkdown({ frontmatter: FM, body: '# imported' });
    const result = await importMarkdownText(text, 'new-note.md');
    expect(createProject).toHaveBeenCalledWith('My Project', expect.any(String));
    expect(createSubject).toHaveBeenCalledWith('My Project', 'new-note.md');
    expect(saveSubjectContent).toHaveBeenCalledWith('My Project', 'new-note.md', expect.stringContaining('imported'));
    expect(loadForSubject).toHaveBeenCalled();
    expect(snapshotCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'import', sourceActor: 'codex' }),
    );
    expect(result.kind).toBe('subject_created');
  });

  it('uses "Importados" project when title has no slash', async () => {
    const fmNoSlash = { ...FM, title: 'orphan-note.md' };
    const text = stringifyPlanMarkdown({ frontmatter: fmNoSlash, body: 'b' });
    await importMarkdownText(text, 'orphan-note.md');
    expect(createProject).toHaveBeenCalledWith('Importados', expect.any(String));
    expect(createSubject).toHaveBeenCalledWith('Importados', 'orphan-note.md');
  });

  it('skips createProject when project already exists', async () => {
    projects = [{ name: 'My Project', path: '' }];
    const text = stringifyPlanMarkdown({ frontmatter: FM, body: 'body' });
    await importMarkdownText(text, 'x.md');
    expect(createProject).not.toHaveBeenCalled();
    expect(createSubject).toHaveBeenCalled();
  });
});
