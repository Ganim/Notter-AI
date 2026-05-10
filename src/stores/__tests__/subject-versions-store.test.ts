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
  updateSubjectCurrentVersion: vi.fn().mockResolvedValue(undefined),
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

  it('snapshotCurrent prepends a new version with the supplied parentVersionId', async () => {
    const { pushSubjectVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');

    // Seed an existing version that the caller will pass as parent.
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
    expect(inserted!.contentMarkdown).toBe('# new content');
    expect(inserted!.label).toBe('milestone');
    expect(inserted!.parentVersionId).toBe('old');
    expect(inserted!.source).toBe('user');

    const versions = useSubjectVersionsStore.getState().versions;
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual(inserted);
    expect(pushSubjectVersion).toHaveBeenCalledOnce();
  });

  it('snapshotCurrent supports source=ai with sourceActor', async () => {
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const inserted = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: '# AI output',
      source: 'ai',
      sourceActor: 'claude',
      label: 'Claude · revisão',
      parentVersionId: null,
    });
    expect(inserted!.source).toBe('ai');
    expect(inserted!.sourceActor).toBe('claude');
    expect(inserted!.parentVersionId).toBeNull();
  });

  it('snapshotCurrent returns null and inserts nothing when no subject is selected', async () => {
    const { pushSubjectVersion } = await import('@/lib/sync');
    const result = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: '# orphan',
      source: 'user',
    });
    expect(result).toBeNull();
    expect(pushSubjectVersion).not.toHaveBeenCalled();
  });

  it('snapshotCurrent returns null when push fails', async () => {
    const { pushSubjectVersion } = await import('@/lib/sync');
    (pushSubjectVersion as any).mockResolvedValueOnce(null);
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const result = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: '# fail',
      source: 'user',
    });
    expect(result).toBeNull();
    expect(useSubjectVersionsStore.getState().versions).toEqual([]);
  });

  it('snapshotAndAdopt creates the version and writes current_version_id', async () => {
    const { updateSubjectCurrentVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const inserted = await useSubjectVersionsStore.getState().snapshotAndAdopt({
      contentMarkdown: '# new',
      source: 'ai',
      sourceActor: 'claude',
      label: 'Claude · revisão',
      parentVersionId: null,
    });
    expect(inserted).not.toBeNull();
    expect(updateSubjectCurrentVersion).toHaveBeenCalledWith('u1', 's1', inserted!.id);
    expect(useSubjectVersionsStore.getState().previewVersionId).toBeNull();
  });

  it('snapshotAndAdopt returns null when snapshotCurrent fails', async () => {
    const { pushSubjectVersion, updateSubjectCurrentVersion } = await import('@/lib/sync');
    (pushSubjectVersion as any).mockResolvedValueOnce(null);
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const result = await useSubjectVersionsStore.getState().snapshotAndAdopt({
      contentMarkdown: '# fail',
      source: 'ai',
    });
    expect(result).toBeNull();
    expect(updateSubjectCurrentVersion).not.toHaveBeenCalled();
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

  it('adoptVersion writes current_version_id, clears preview, returns the version', async () => {
    const { updateSubjectCurrentVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');
    const target = {
      id: 'v1', subjectId: 's1', userId: 'u1', contentMarkdown: '# v1',
      parentVersionId: null, source: 'user' as const, sourceActor: null,
      label: null, createdAt: '',
    };
    useSubjectVersionsStore.getState().applyRemoteVersions([target]);
    useSubjectVersionsStore.getState().enterPreview('v1');

    const adopted = await useSubjectVersionsStore.getState().adoptVersion('v1');

    expect(adopted).toEqual(target);
    expect(updateSubjectCurrentVersion).toHaveBeenCalledWith('u1', 's1', 'v1');
    expect(useSubjectVersionsStore.getState().previewVersionId).toBeNull();
  });

  it('adoptVersion warns and returns null when version is unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { updateSubjectCurrentVersion } = await import('@/lib/sync');
    await useSubjectVersionsStore.getState().loadForSubject('s1');

    const result = await useSubjectVersionsStore.getState().adoptVersion('does-not-exist');

    expect(result).toBeNull();
    expect(updateSubjectCurrentVersion).not.toHaveBeenCalled();
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
