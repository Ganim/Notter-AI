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
// Post-2026-05-14 createSubject signature:
//   (projectName, fileName, initialContent?, initialVersionMeta?)
// The new import flow commits the body as the initial version with
// source='import', so it relies on createSubject populating currentVersionId
// on the subjectRows entry it injects.
const createSubject = vi.fn().mockImplementation(
  async (proj: string, file: string, _content?: string, _meta?: unknown) => {
    subjectRows.push({
      id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      projectName: proj,
      fileName: file,
      content: _content ?? '',
      currentVersionId: 'vvvvvvvv-vvvv-4vvv-vvvv-vvvvvvvvvvvv',
    });
  },
);

vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      get subjectRows() { return subjectRows; },
      get projects() { return projects; },
      createProject,
      createSubject,
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
  // Valid UUID shape but absent from subjectRows in this suite — exercises
  // the case-B (subject-not-found) path. Original spec used "unknown1-..."
  // which fails frontmatter UUID validation before reaching the orchestrator.
  subject_id: '22222222-2222-4222-9222-222222222222',
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

  it('creates project + subject with import metadata on the initial version', async () => {
    const text = stringifyPlanMarkdown({ frontmatter: FM, body: '# imported' });
    const result = await importMarkdownText(text, 'new-note.md');
    expect(createProject).toHaveBeenCalledWith('My Project', expect.any(String));
    // body is passed as initialContent and import provenance flows through
    // initialVersionMeta — no second snapshotCurrent call needed.
    expect(createSubject).toHaveBeenCalledWith(
      'My Project',
      'new-note.md',
      expect.stringContaining('imported'),
      expect.objectContaining({
        source: 'import',
        sourceActor: 'codex',
        label: expect.stringContaining('Importado de'),
      }),
    );
    expect(loadForSubject).toHaveBeenCalled();
    // snapshotCurrent is NOT called in case B anymore — the initial version
    // already carries import provenance.
    expect(snapshotCurrent).not.toHaveBeenCalled();
    expect(result.kind).toBe('subject_created');
    if (result.kind === 'subject_created') {
      expect(result.versionId).toBe('vvvvvvvv-vvvv-4vvv-vvvv-vvvvvvvvvvvv');
    }
  });

  it('uses "Importados" project when title has no slash', async () => {
    const fmNoSlash = { ...FM, title: 'orphan-note.md' };
    const text = stringifyPlanMarkdown({ frontmatter: fmNoSlash, body: 'b' });
    await importMarkdownText(text, 'orphan-note.md');
    expect(createProject).toHaveBeenCalledWith('Importados', expect.any(String));
    expect(createSubject).toHaveBeenCalledWith(
      'Importados',
      'orphan-note.md',
      expect.any(String),
      expect.objectContaining({ source: 'import' }),
    );
  });

  it('skips createProject when project already exists', async () => {
    projects = [{ name: 'My Project', path: '' }];
    const text = stringifyPlanMarkdown({ frontmatter: FM, body: 'body' });
    await importMarkdownText(text, 'x.md');
    expect(createProject).not.toHaveBeenCalled();
    expect(createSubject).toHaveBeenCalled();
  });
});
