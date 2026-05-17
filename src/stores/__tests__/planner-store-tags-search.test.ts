// src/stores/__tests__/planner-store-tags-search.test.ts
//
// Phase 4 — verifies the search/archive slices and exported selectors added
// in tasks 4.1–4.2:
//   selectVisibleProjects, selectArchivedCount,
//   selectSubjectSearchHits, selectExactIdentifierMatch.
//
// All Tauri FS and Supabase side effects are mocked away.
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  commitSubjectVersion: vi.fn().mockResolvedValue('v-new'),
  renameSubjectInPlace: vi.fn().mockResolvedValue({ ok: true }),
  fetchSubjectVersions: vi.fn().mockResolvedValue([]),
  archiveProject: vi.fn().mockResolvedValue({ ok: true }),
  unarchiveProject: vi.fn().mockResolvedValue({ ok: true }),
  updateProjectTag: vi.fn().mockResolvedValue({ ok: true }),
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

import {
  usePlannerStore,
  selectVisibleProjects,
  selectArchivedCount,
  selectSubjectSearchHits,
  selectExactIdentifierMatch,
} from '@/stores/planner-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { Project } from '@/types';
import type { SubjectRecord } from '@/lib/sync';

const ws = '00000000-0000-0000-0000-0000000000ws';

function P(name: string, tag: string, archived = false): Project {
  return {
    name,
    path: `/${name}`,
    workspaceId: ws,
    tag,
    nextSubjectSeq: 4,
    archivedAt: archived ? '2026-05-01T00:00:00Z' : null,
  };
}

function S(projectName: string, fileName: string, seq: number): SubjectRecord {
  return {
    id: `${projectName}-${seq}`,
    projectName,
    fileName,
    content: '',
    currentVersionId: null,
    seq,
    archivedAt: null,
  };
}

beforeEach(() => {
  // Seed the workspaces store so the current workspace matches our test projects.
  useWorkspacesStore.setState({
    currentWorkspaceId: ws,
    workspaces: [
      {
        id: ws,
        name: 'Test',
        isDefault: true,
        currentRole: 'owner',
        memberCount: 1,
        userId: 'u1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    currentRole: 'owner',
    memberCounts: { [ws]: 1 },
    members: {},
    pendingInvites: {},
    loading: false,
  } as any);

  usePlannerStore.setState({
    allProjects: [P('flow', 'flow'), P('old', 'old', true)],
    subjectRows: [S('flow', 'login.md', 1), S('flow', 'reset-password.md', 3)],
    searchQuery: '',
    searchMode: 'active',
  } as any);
});

describe('planner-store selectors — tags/search/archive', () => {
  it('selectVisibleProjects hides archived in active mode', () => {
    expect(
      selectVisibleProjects(usePlannerStore.getState()).map((p) => p.name),
    ).toEqual(['flow']);
  });

  it('selectVisibleProjects shows only archived in archived mode', () => {
    usePlannerStore.setState({ searchMode: 'archived' });
    expect(
      selectVisibleProjects(usePlannerStore.getState()).map((p) => p.name),
    ).toEqual(['old']);
  });

  it('selectVisibleProjects filters by name substring', () => {
    usePlannerStore.setState({ searchQuery: 'flo' });
    expect(
      selectVisibleProjects(usePlannerStore.getState()).map((p) => p.name),
    ).toEqual(['flow']);
  });

  it('selectVisibleProjects filters by tag prefix', () => {
    usePlannerStore.setState({ searchQuery: 'fl' });
    expect(
      selectVisibleProjects(usePlannerStore.getState()).map((p) => p.name),
    ).toEqual(['flow']);
  });

  it('selectVisibleProjects returns empty when no match', () => {
    usePlannerStore.setState({ searchQuery: 'xx' });
    expect(selectVisibleProjects(usePlannerStore.getState())).toEqual([]);
  });

  it('selectArchivedCount counts archived rows in current workspace', () => {
    expect(selectArchivedCount(usePlannerStore.getState())).toBe(1);
  });

  it('selectSubjectSearchHits matches on fileName across active projects', () => {
    usePlannerStore.setState({ searchQuery: 'login' });
    const hits = selectSubjectSearchHits(usePlannerStore.getState());
    expect(hits).toHaveLength(1);
    expect(hits[0].subject.fileName).toBe('login.md');
    expect(hits[0].project.name).toBe('flow');
  });

  it('selectSubjectSearchHits returns empty in archived mode', () => {
    usePlannerStore.setState({ searchQuery: 'login', searchMode: 'archived' });
    expect(selectSubjectSearchHits(usePlannerStore.getState())).toEqual([]);
  });

  it('selectExactIdentifierMatch resolves flow-3 to the right subject', () => {
    usePlannerStore.setState({ searchQuery: 'flow-3' });
    const m = selectExactIdentifierMatch(usePlannerStore.getState());
    expect(m?.subject.seq).toBe(3);
    expect(m?.project.name).toBe('flow');
  });

  it('selectExactIdentifierMatch returns null when seq missing', () => {
    usePlannerStore.setState({ searchQuery: 'flow-99' });
    expect(selectExactIdentifierMatch(usePlannerStore.getState())).toBeNull();
  });

  it('selectExactIdentifierMatch returns null on non-identifier shape', () => {
    usePlannerStore.setState({ searchQuery: 'flow' });
    expect(selectExactIdentifierMatch(usePlannerStore.getState())).toBeNull();
  });
});
