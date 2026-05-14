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
  const rpc = vi.fn().mockResolvedValue({ data: 'v-new', error: null });
  const from = vi.fn((_table: string) => ({
    upsert,
    insert,
    delete: del,
    select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  }));
  return { supabase: { from, rpc }, isSupabaseConfigured: true };
});

// Tests drive the store through the public API; we mock the sync layer so we
// can assert what each method dispatches without hitting Supabase.
vi.mock('@/lib/sync', () => ({
  fetchSubjectVersions: vi.fn().mockResolvedValue([]),
  commitSubjectVersion: vi.fn().mockResolvedValue('v-new'),
  fetchSubjectComments: vi.fn().mockResolvedValue([]),
  pushSubjectComment: vi.fn().mockResolvedValue(undefined),
  deleteSubjectComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'u1' } }),
  },
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
    const { currentSubjectId, versions, comments, previewVersionId } =
      useSubjectVersionsStore.getState();
    expect(currentSubjectId).toBeNull();
    expect(versions).toEqual([]);
    expect(comments).toEqual([]);
    expect(previewVersionId).toBeNull();
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

  it('clearSubject clears currentSubjectId, slices, and preview', async () => {
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    useSubjectVersionsStore.getState().enterPreview('v1');
    useSubjectVersionsStore.getState().clearSubject();
    const state = useSubjectVersionsStore.getState();
    expect(state.currentSubjectId).toBeNull();
    expect(state.versions).toEqual([]);
    expect(state.comments).toEqual([]);
    expect(state.previewVersionId).toBeNull();
  });

  it('snapshotCurrent calls commit_subject_version and prepends the new row', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    (commitSubjectVersion as any).mockResolvedValueOnce('v-new');
    await useSubjectVersionsStore.getState().loadForSubject('s1');

    // Seed an existing version that the caller passes as parent.
    useSubjectVersionsStore.getState().applyRemoteVersions([
      { id: 'old', subjectId: 's1', userId: 'u1', contentMarkdown: '# old', parentVersionId: null, source: 'user', sourceActor: null, label: null, createdAt: '' },
    ]);

    const inserted = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: '# new content',
      source: 'user',
      label: 'milestone',
      parentVersionId: 'old',
    });

    expect(inserted).not.toBeNull();
    expect(inserted!.id).toBe('v-new');
    expect(inserted!.contentMarkdown).toBe('# new content');
    expect(inserted!.label).toBe('milestone');
    expect(inserted!.parentVersionId).toBe('old');
    expect(commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 's1',
        content: '# new content',
        source: 'user',
        parentVersionId: 'old',
      }),
    );

    const versions = useSubjectVersionsStore.getState().versions;
    expect(versions).toHaveLength(2);
    expect(versions[0].id).toBe('v-new');
  });

  it('snapshotCurrent threads coalesceWindowSecs to the RPC', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: 'x',
      source: 'user',
      coalesceWindowSecs: 60,
    });
    expect(commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({ coalesceWindowSecs: 60 }),
    );
  });

  it('snapshotCurrent replaces in place when the RPC coalesced onto an existing row', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    useSubjectVersionsStore.getState().applyRemoteVersions([
      { id: 'existing', subjectId: 's1', userId: 'u1', contentMarkdown: 'a', parentVersionId: null, source: 'user', sourceActor: null, label: 'first', createdAt: '2026-05-14T00:00:00Z' },
    ]);
    // RPC coalesced and returned the SAME id back.
    (commitSubjectVersion as any).mockResolvedValueOnce('existing');

    await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: 'a + b',
      source: 'user',
      coalesceWindowSecs: 60,
    });

    const versions = useSubjectVersionsStore.getState().versions;
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe('existing');
    expect(versions[0].contentMarkdown).toBe('a + b');
    // createdAt is preserved on coalesce-replace (the store doesn't bump it;
    // the realtime refetch reconciles to the server's bumped value).
    expect(versions[0].createdAt).toBe('2026-05-14T00:00:00Z');
  });

  it('snapshotCurrent returns null and inserts nothing when no subject is selected', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    const result = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: '# orphan',
      source: 'user',
    });
    expect(result).toBeNull();
    expect(commitSubjectVersion).not.toHaveBeenCalled();
  });

  it('snapshotCurrent returns null when commit fails', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    (commitSubjectVersion as any).mockResolvedValueOnce(null);
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const result = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: '# fail',
      source: 'user',
    });
    expect(result).toBeNull();
    expect(useSubjectVersionsStore.getState().versions).toEqual([]);
  });

  it('snapshotAndAdopt is identical to snapshotCurrent (RPC always adopts)', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    await useSubjectVersionsStore.getState().snapshotAndAdopt({
      contentMarkdown: '# new',
      source: 'ai',
      sourceActor: 'claude',
      label: 'Claude · revisão',
      parentVersionId: null,
    });
    expect(commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'ai', sourceActor: 'claude' }),
    );
  });

  it('enterPreview / exitPreview toggle previewVersionId', () => {
    useSubjectVersionsStore.getState().enterPreview('v1');
    expect(useSubjectVersionsStore.getState().previewVersionId).toBe('v1');
    useSubjectVersionsStore.getState().enterPreview('v1'); // idempotent
    expect(useSubjectVersionsStore.getState().previewVersionId).toBe('v1');
    useSubjectVersionsStore.getState().enterPreview('v2');
    expect(useSubjectVersionsStore.getState().previewVersionId).toBe('v2');
    useSubjectVersionsStore.getState().exitPreview();
    expect(useSubjectVersionsStore.getState().previewVersionId).toBeNull();
    useSubjectVersionsStore.getState().exitPreview(); // idempotent
    expect(useSubjectVersionsStore.getState().previewVersionId).toBeNull();
  });

  it('adoptVersion creates a new copy-version with parent = adopted, clears preview', async () => {
    const { commitSubjectVersion } = await import('@/lib/sync');
    (commitSubjectVersion as any).mockResolvedValueOnce('v-adopt');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const target = {
      id: 'v-historic', subjectId: 's1', userId: 'u1', contentMarkdown: '# historic',
      parentVersionId: null, source: 'user' as const, sourceActor: null,
      label: 'Stable point', createdAt: '',
    };
    useSubjectVersionsStore.getState().applyRemoteVersions([target]);
    useSubjectVersionsStore.getState().enterPreview('v-historic');

    const adopted = await useSubjectVersionsStore.getState().adoptVersion('v-historic');

    expect(adopted).not.toBeNull();
    expect(adopted!.id).toBe('v-adopt');
    expect(adopted!.contentMarkdown).toBe('# historic'); // copy of target
    expect(adopted!.parentVersionId).toBe('v-historic'); // chained back
    expect(commitSubjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 's1',
        content: '# historic',
        source: 'user',
        sourceActor: 'adopt',
        parentVersionId: 'v-historic',
        coalesceWindowSecs: 0,
      }),
    );
    expect(useSubjectVersionsStore.getState().previewVersionId).toBeNull();
  });

  it('adoptVersion warns and returns null when target is unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { commitSubjectVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');

    const result = await useSubjectVersionsStore.getState().adoptVersion('does-not-exist');

    expect(result).toBeNull();
    expect(commitSubjectVersion).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

  it('reset clears all slices including preview', async () => {
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    useSubjectVersionsStore.getState().applyRemoteVersions([
      { id: 'v1', subjectId: 's1', userId: 'u1', contentMarkdown: '# v1', parentVersionId: null, source: 'user', sourceActor: null, label: null, createdAt: '' },
    ]);
    useSubjectVersionsStore.getState().enterPreview('v1');
    useSubjectVersionsStore.getState().reset();
    const s = useSubjectVersionsStore.getState();
    expect(s.currentSubjectId).toBeNull();
    expect(s.versions).toEqual([]);
    expect(s.comments).toEqual([]);
    expect(s.previewVersionId).toBeNull();
  });
});
