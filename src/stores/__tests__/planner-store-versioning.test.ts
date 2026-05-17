// src/stores/__tests__/planner-store-versioning.test.ts
//
// Regression tests for the 2026-05-14 versioning overhaul:
//   - applyRemoteSubjects must NOT clobber the active subject's local file.
//   - applyRemoteSubjects only hydrates non-existing files for inactive
//     subjects (subsequent edits propagate via their own autosave, not here).
//   - renameSubject calls the in-place rename RPC, not delete+insert.
//   - createSubject commits the initial version via commit_subject_version
//     and threads optional `initialVersionMeta` overrides.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so factory-local refs survive vi.mock hoisting.
const fs = vi.hoisted(() => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(''),
  exists: vi.fn().mockResolvedValue(true),
  rename: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppLocalData: 'AppLocalData' },
  readDir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: fs.readTextFile,
  writeTextFile: fs.writeTextFile,
  exists: fs.exists,
  remove: vi.fn().mockResolvedValue(undefined),
  rename: fs.rename,
}));

const sync = vi.hoisted(() => ({
  commitSubjectVersion: vi.fn().mockResolvedValue('v-new'),
  renameSubjectInPlace: vi.fn().mockResolvedValue({ ok: true }),
  createSubjectViaRpc: vi.fn().mockImplementation(async (projectName: string, fileName: string, content: string) => ({
    ok: true,
    subject: {
      id: 'subj-rpc',
      projectName,
      fileName,
      content,
      currentVersionId: null,
      seq: 1,
      archivedAt: null,
    },
  })),
}));
vi.mock('@/lib/sync', () => ({
  pushProjects: vi.fn().mockResolvedValue(undefined),
  deleteRemoteSubject: vi.fn().mockResolvedValue(undefined),
  deleteRemoteSubjectsByProject: vi.fn().mockResolvedValue(undefined),
  renameRemoteSubjectsProject: vi.fn().mockResolvedValue(undefined),
  updateProjectWorkspace: vi.fn().mockResolvedValue(undefined),
  commitSubjectVersion: sync.commitSubjectVersion,
  renameSubjectInPlace: sync.renameSubjectInPlace,
  createSubjectViaRpc: sync.createSubjectViaRpc,
  archiveProject: vi.fn().mockResolvedValue({ ok: true }),
  unarchiveProject: vi.fn().mockResolvedValue({ ok: true }),
  updateProjectTag: vi.fn().mockResolvedValue({ ok: true }),
  fetchSubjectVersions: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/synced-store', () => ({
  deleteUserRow: vi.fn().mockResolvedValue(undefined),
  // makeDebouncedSync stub: schedule fires the pushFn synchronously so we
  // can assert side-effects without faking timers.
  makeDebouncedSync: vi.fn((pushFn: any) => ({
    schedule: (payload: any) => {
      void pushFn('u1', payload);
    },
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));

vi.mock('@/stores/subject-versions-store', () => ({
  useSubjectVersionsStore: {
    getState: () => ({
      clearSubject: vi.fn(),
      loadForSubject: vi.fn(),
      currentSubjectId: null,
      applyRemoteVersions: vi.fn(),
    }),
  },
}));

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  accountScopedPath: (rel: string) => `notter-ai/acc-1/${rel}`,
  tryAccountScopedPath: (rel: string) => `notter-ai/acc-1/${rel}`,
}));

import { usePlannerStore } from '@/stores/planner-store';

describe('planner-store — versioning overhaul', () => {
  beforeEach(() => {
    usePlannerStore.getState().reset();
    vi.clearAllMocks();
    fs.exists.mockReset();
  });

  // ── applyRemoteSubjects ─────────────────────────────────────────────────

  it('applyRemoteSubjects does NOT write the active subject to disk', async () => {
    // User is actively editing this subject.
    usePlannerStore.setState({
      selectedProject: { name: 'P', path: '', workspaceId: 'w1' } as any,
      selectedSubject: 'open.md',
    });
    // The "remote" content is stale (server hasn't received the latest
    // keystroke yet). We must NOT overwrite the user's in-flight edits.
    fs.exists.mockResolvedValue(true);
    await usePlannerStore.getState().applyRemoteSubjects([
      { id: 's1', projectName: 'P', fileName: 'open.md', content: 'STALE', currentVersionId: 'v1', seq: 1, archivedAt: null },
    ]);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
    // Slice is still updated so SnapshotPanel sees the new currentVersionId.
    expect(usePlannerStore.getState().subjectRows).toHaveLength(1);
    expect(usePlannerStore.getState().subjectRows[0].currentVersionId).toBe('v1');
  });

  it('applyRemoteSubjects writes missing files and skips up-to-date inactive ones', async () => {
    usePlannerStore.setState({
      selectedProject: { name: 'P', path: '', workspaceId: 'w1' } as any,
      selectedSubject: 'open.md',
      // Prior in-memory state has hydrated.md with the SAME content the
      // remote is reporting — steady-state echo, no write expected.
      subjectRows: [
        { id: 's-hydrated', projectName: 'P', fileName: 'hydrated.md', content: 'older', currentVersionId: 'v2', seq: 1, archivedAt: null },
      ],
    });
    fs.exists
      .mockResolvedValueOnce(false) // missing.md not on disk → write
      .mockResolvedValueOnce(true); // hydrated.md already exists, content unchanged → skip
    await usePlannerStore.getState().applyRemoteSubjects([
      { id: 's-missing', projectName: 'P', fileName: 'missing.md', content: 'fresh', currentVersionId: 'v1', seq: 2, archivedAt: null },
      { id: 's-hydrated', projectName: 'P', fileName: 'hydrated.md', content: 'older', currentVersionId: 'v2', seq: 1, archivedAt: null },
    ]);
    expect(fs.writeTextFile).toHaveBeenCalledTimes(1);
    const args = fs.writeTextFile.mock.calls[0];
    expect(String(args[0])).toContain('missing.md');
    expect(args[1]).toBe('fresh');
  });

  it('applyRemoteSubjects overwrites the disk file when remote content moved (e.g. MCP UPDATE)', async () => {
    usePlannerStore.setState({
      selectedProject: { name: 'P', path: '', workspaceId: 'w1' } as any,
      selectedSubject: 'open.md',
      subjectRows: [
        // prior content was empty (the stub from save_subject's INSERT)
        { id: 's-mcp', projectName: 'P', fileName: 'mcp.md', content: '', currentVersionId: 'v0', seq: 1, archivedAt: null },
      ],
    });
    fs.exists.mockResolvedValueOnce(true); // stub file already on disk
    await usePlannerStore.getState().applyRemoteSubjects([
      // post_subject_revision pushed the real content — UPDATE event fires.
      { id: 's-mcp', projectName: 'P', fileName: 'mcp.md', content: 'real plan body', currentVersionId: 'v1', seq: 1, archivedAt: null },
    ]);
    expect(fs.writeTextFile).toHaveBeenCalledTimes(1);
    expect(fs.writeTextFile.mock.calls[0][1]).toBe('real plan body');
  });

  it('applyRemoteSubjects repairs an empty stub on cold start when remote has content', async () => {
    // No subjectRows → prior is undefined, mimicking app boot.
    usePlannerStore.setState({
      selectedProject: { name: 'P', path: '', workspaceId: 'w1' } as any,
      selectedSubject: 'open.md',
      subjectRows: [],
    });
    fs.exists.mockResolvedValueOnce(true);     // stub file present
    fs.readTextFile.mockResolvedValueOnce(''); // disk is empty
    await usePlannerStore.getState().applyRemoteSubjects([
      { id: 's-stub', projectName: 'P', fileName: 'stub.md', content: 'recovered body', currentVersionId: 'v1', seq: 1, archivedAt: null },
    ]);
    expect(fs.writeTextFile).toHaveBeenCalledTimes(1);
    expect(fs.writeTextFile.mock.calls[0][1]).toBe('recovered body');
  });

  // ── renameSubject ──────────────────────────────────────────────────────

  it('renameSubject calls the in-place rename RPC and never touches the version FK chain', async () => {
    usePlannerStore.setState({
      selectedProject: { name: 'P', path: '', workspaceId: 'w1' } as any,
      selectedSubject: 'old.md',
      subjectRows: [
        { id: 'subj-1', projectName: 'P', fileName: 'old.md', content: '', currentVersionId: 'v1', seq: 1, archivedAt: null },
      ],
      subjects: ['old.md'],
    });
    await usePlannerStore.getState().renameSubject('P', 'old.md', 'new');
    expect(sync.renameSubjectInPlace).toHaveBeenCalledWith('subj-1', 'new.md');
    // subjectRows.id is preserved (no delete+insert), so all subject_versions
    // / subject_comments FKs survive.
    const rows = usePlannerStore.getState().subjectRows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('subj-1');
    expect(rows[0].fileName).toBe('new.md');
    expect(usePlannerStore.getState().selectedSubject).toBe('new.md');
  });

  it('renameSubject rolls back local state when the RPC reports duplicate_name', async () => {
    sync.renameSubjectInPlace.mockResolvedValueOnce({
      ok: false,
      code: 'duplicate_name',
      message: 'file_name already exists',
    });
    usePlannerStore.setState({
      selectedProject: { name: 'P', path: '', workspaceId: 'w1' } as any,
      selectedSubject: 'old.md',
      subjectRows: [
        { id: 'subj-1', projectName: 'P', fileName: 'old.md', content: '', currentVersionId: 'v1', seq: 1, archivedAt: null },
      ],
      subjects: ['old.md'],
    });
    await expect(
      usePlannerStore.getState().renameSubject('P', 'old.md', 'taken'),
    ).rejects.toThrow(/duplicate_name/);
    const rows = usePlannerStore.getState().subjectRows;
    expect(rows[0].fileName).toBe('old.md');
    expect(usePlannerStore.getState().selectedSubject).toBe('old.md');
  });

  // ── createSubject ──────────────────────────────────────────────────────

  it('createSubject commits the initial version through the RPC', async () => {
    await usePlannerStore.getState().createSubject('P', 'note.md', 'hello world');
    expect(sync.createSubjectViaRpc).toHaveBeenCalledWith('P', 'note.md', 'hello world');
    expect(sync.commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello world',
        source: 'user',
        sourceActor: 'initial',
        label: 'Versão inicial',
        parentVersionId: null,
        coalesceWindowSecs: 0,
      }),
    );
    const row = usePlannerStore
      .getState()
      .subjectRows.find((r) => r.fileName === 'note.md');
    expect(row).toBeDefined();
    expect(row!.currentVersionId).toBe('v-new');
  });

  it('createSubject honors initialVersionMeta (import path)', async () => {
    await usePlannerStore.getState().createSubject('P', 'imported.md', 'body', {
      source: 'import',
      sourceActor: 'codex',
      label: 'Importado de foo.md',
    });
    expect(sync.commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'import',
        sourceActor: 'codex',
        label: 'Importado de foo.md',
      }),
    );
  });

  // ── saveSubjectContent → autosave debounce ─────────────────────────────

  it('saveSubjectContent commits a coalescing version when a remote row exists', async () => {
    usePlannerStore.setState({
      subjectRows: [
        { id: 'subj-1', projectName: 'P', fileName: 'doc.md', content: '', currentVersionId: 'v-parent', seq: 1, archivedAt: null },
      ],
    });
    await usePlannerStore.getState().saveSubjectContent('P', 'doc.md', 'typed something');
    // The makeDebouncedSync stub fires synchronously, so commit ran.
    expect(sync.commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 'subj-1',
        content: 'typed something',
        source: 'user',
        sourceActor: null,
        parentVersionId: 'v-parent',
        // The 60s window collapses one typing session into one row.
        coalesceWindowSecs: 60,
      }),
    );
  });

  it('saveSubjectContent skips the commit when no remote row exists yet', async () => {
    await usePlannerStore.getState().saveSubjectContent('P', 'orphan.md', 'x');
    expect(sync.commitSubjectVersion).not.toHaveBeenCalled();
  });

  // ── writeSubjectFileOnly ───────────────────────────────────────────────

  it('writeSubjectFileOnly writes the file without scheduling a commit', async () => {
    await usePlannerStore.getState().writeSubjectFileOnly('P', 'doc.md', 'content');
    expect(fs.writeTextFile).toHaveBeenCalledTimes(1);
    expect(sync.commitSubjectVersion).not.toHaveBeenCalled();
  });
});
