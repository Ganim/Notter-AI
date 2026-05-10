// src/stores/__tests__/subject-versions-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';

// ── Shared mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const insert = vi.fn(() => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'v1' }, error: null }),
    }),
  }));
  const del = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
  const from = vi.fn((_table: string) => ({
    upsert,
    insert,
    delete: del,
    select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  }));
  return { supabase: { from }, isSupabaseConfigured: true };
});

vi.mock('@/lib/sync', () => ({
  fetchSubjectVersions: vi.fn().mockResolvedValue([]),
  pushSubjectVersion: vi.fn().mockResolvedValue({ id: 'v1' }),
  fetchSubjectComments: vi.fn().mockResolvedValue([]),
  pushSubjectComment: vi.fn().mockResolvedValue(undefined),
  deleteSubjectComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SubjectVersionsStore', () => {
  beforeEach(() => {
    useSubjectVersionsStore.getState().reset();
    vi.clearAllMocks();
  });

  it('starts with empty state', () => {
    const { currentSubjectId, versions, comments } = useSubjectVersionsStore.getState();
    expect(currentSubjectId).toBeNull();
    expect(versions).toEqual([]);
    expect(comments).toEqual([]);
  });

  it('loadForSubject sets currentSubjectId and populates slices', async () => {
    const { fetchSubjectVersions, fetchSubjectComments } = await import('@/lib/sync');
    const remoteVersions = [
      { id: 'v1', subjectId: 's1', userId: 'u1', contentMarkdown: '# v1', parentVersionId: null, source: 'user' as const, sourceActor: null, label: null, createdAt: '' },
    ];
    const remoteComments = [
      { id: 'c1', subjectId: 's1', versionId: 'v1', userId: 'u1', authorUserId: 'u1', body: 'Nice', resolved: false, createdAt: '', updatedAt: '' },
    ];
    (fetchSubjectVersions as any).mockResolvedValueOnce(remoteVersions);
    (fetchSubjectComments as any).mockResolvedValueOnce(remoteComments);

    await useSubjectVersionsStore.getState().loadForSubject('s1');

    const state = useSubjectVersionsStore.getState();
    expect(state.currentSubjectId).toBe('s1');
    expect(state.versions).toEqual(remoteVersions);
    expect(state.comments).toEqual(remoteComments);
  });

  it('clearSubject clears currentSubjectId and slices', async () => {
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    useSubjectVersionsStore.getState().clearSubject();
    const state = useSubjectVersionsStore.getState();
    expect(state.currentSubjectId).toBeNull();
    expect(state.versions).toEqual([]);
    expect(state.comments).toEqual([]);
  });

  it('snapshotCurrent prepends a new user version with parent linked to the previous head', async () => {
    const { pushSubjectVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');

    // Seed an existing version so the new snapshot's parent is non-null.
    useSubjectVersionsStore.getState().applyRemoteVersions([
      { id: 'old', subjectId: 's1', userId: 'u1', contentMarkdown: '# old', parentVersionId: null, source: 'user', sourceActor: null, label: null, createdAt: '' },
    ]);

    await useSubjectVersionsStore.getState().snapshotCurrent('# new content', 'milestone');

    const versions = useSubjectVersionsStore.getState().versions;
    expect(versions).toHaveLength(2);
    expect(versions[0].contentMarkdown).toBe('# new content');
    expect(versions[0].label).toBe('milestone');
    expect(versions[0].parentVersionId).toBe('old');
    expect(versions[0].source).toBe('user');
    expect(pushSubjectVersion).toHaveBeenCalledOnce();
  });

  it('addComment optimistically appends and pushes via sync', async () => {
    const { pushSubjectComment } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    await useSubjectVersionsStore.getState().addComment('v1', '  hello  ');

    const comments = useSubjectVersionsStore.getState().comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('hello');
    expect(comments[0].versionId).toBe('v1');
    expect(comments[0].subjectId).toBe('s1');
    expect(comments[0].resolved).toBe(false);
    expect(pushSubjectComment).toHaveBeenCalledOnce();
  });

  it('addComment ignores empty bodies', async () => {
    const { pushSubjectComment } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    await useSubjectVersionsStore.getState().addComment('v1', '   ');
    expect(useSubjectVersionsStore.getState().comments).toEqual([]);
    expect(pushSubjectComment).not.toHaveBeenCalled();
  });

  it('applyRemoteVersions and applyRemoteComments replace their slices', () => {
    const versions = [
      { id: 'v1', subjectId: 's1', userId: 'u1', contentMarkdown: '# v1', parentVersionId: null, source: 'user' as const, sourceActor: null, label: null, createdAt: '' },
    ];
    const comments = [
      { id: 'c1', subjectId: 's1', versionId: 'v1', userId: 'u1', authorUserId: 'u1', body: 'Nice', resolved: false, createdAt: '', updatedAt: '' },
    ];
    useSubjectVersionsStore.getState().applyRemoteVersions(versions);
    useSubjectVersionsStore.getState().applyRemoteComments(comments);
    expect(useSubjectVersionsStore.getState().versions).toEqual(versions);
    expect(useSubjectVersionsStore.getState().comments).toEqual(comments);
  });

  it('reset clears all slices', async () => {
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    useSubjectVersionsStore.getState().applyRemoteVersions([
      { id: 'v1', subjectId: 's1', userId: 'u1', contentMarkdown: '# v1', parentVersionId: null, source: 'user', sourceActor: null, label: null, createdAt: '' },
    ]);
    useSubjectVersionsStore.getState().reset();
    const s = useSubjectVersionsStore.getState();
    expect(s.currentSubjectId).toBeNull();
    expect(s.versions).toEqual([]);
    expect(s.comments).toEqual([]);
  });
});
