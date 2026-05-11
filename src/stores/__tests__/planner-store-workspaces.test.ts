// src/stores/__tests__/planner-store-workspaces.test.ts
//
// Phase E — verifies that the planner store now:
//   1. writes incoming remote rows to `allProjects` (canonical slice), and
//   2. exposes `projects` as a workspace-filtered view, recomputed on
//      `applyRemoteProjects` and on `currentWorkspaceId` changes via the
//      cross-store subscription wired at the bottom of planner-store.ts.
//
// Filesystem and sync side effects are mocked away so the assertions focus on
// the new derive-on-mutate behavior.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppLocalData: 'AppLocalData' },
  readDir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(''),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/sync', () => ({
  pushProjects: vi.fn().mockResolvedValue(undefined),
  pushSubject: vi.fn().mockResolvedValue(undefined),
  deleteRemoteSubject: vi.fn().mockResolvedValue(undefined),
  deleteRemoteSubjectsByProject: vi.fn().mockResolvedValue(undefined),
  renameRemoteSubjectsProject: vi.fn().mockResolvedValue(undefined),
  updateProjectWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/synced-store', () => ({
  deleteUserRow: vi.fn().mockResolvedValue(undefined),
  makeDebouncedSync: vi.fn(() => ({
    schedule: vi.fn(),
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
import { useWorkspacesStore } from '@/stores/workspaces-store';

const P = (name: string, workspaceId: string) => ({ name, path: '', workspaceId });

describe('usePlannerStore — workspaces refactor (Phase E)', () => {
  beforeEach(() => {
    usePlannerStore.getState().reset();
    useWorkspacesStore.getState().reset();
  });

  it('applyRemoteProjects writes the full list to allProjects', () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    const rows = [P('alpha', 'w1'), P('beta', 'w2'), P('gamma', 'w1')];
    usePlannerStore.getState().applyRemoteProjects(rows);
    expect(usePlannerStore.getState().allProjects).toEqual(rows);
  });

  it('projects is derived: filtered by currentWorkspaceId', () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    const rows = [P('alpha', 'w1'), P('beta', 'w2'), P('gamma', 'w1')];
    usePlannerStore.getState().applyRemoteProjects(rows);
    const filtered = usePlannerStore.getState().projects.map((p) => p.name);
    expect(filtered).toEqual(['alpha', 'gamma']);
  });

  it('switching workspace re-derives projects without a refetch', () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    const rows = [P('alpha', 'w1'), P('beta', 'w2'), P('gamma', 'w1')];
    usePlannerStore.getState().applyRemoteProjects(rows);
    expect(usePlannerStore.getState().projects.map((p) => p.name)).toEqual(['alpha', 'gamma']);

    // Switch to w2 — the cross-store subscription should re-filter.
    useWorkspacesStore.getState().setCurrentWorkspaceId('w2');
    expect(usePlannerStore.getState().projects.map((p) => p.name)).toEqual(['beta']);
    // Canonical slice is untouched.
    expect(usePlannerStore.getState().allProjects.length).toBe(3);
  });

  it('workspace switch clears selectedProject when it no longer belongs', () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    const rows = [P('alpha', 'w1'), P('beta', 'w2')];
    usePlannerStore.getState().applyRemoteProjects(rows);
    // Pretend the user had alpha selected in w1.
    usePlannerStore.setState({ selectedProject: rows[0] });

    useWorkspacesStore.getState().setCurrentWorkspaceId('w2');
    expect(usePlannerStore.getState().selectedProject).toBeNull();
  });

  it('createProject bails when no active workspace (post-bootstrap UI gate)', async () => {
    const before = usePlannerStore.getState().allProjects.length;
    useWorkspacesStore.getState().setCurrentWorkspaceId(null);
    await usePlannerStore.getState().createProject('orphan', '/tmp/orphan');
    expect(usePlannerStore.getState().allProjects.length).toBe(before);
  });

  it('createProject stamps workspaceId from useWorkspacesStore', async () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w-active');
    await usePlannerStore.getState().createProject('alpha', '/tmp/alpha');
    const created = usePlannerStore.getState().allProjects.find((p) => p.name === 'alpha');
    expect(created?.workspaceId).toBe('w-active');
    // Visible in derived view too.
    expect(usePlannerStore.getState().projects.map((p) => p.name)).toContain('alpha');
  });
});
