// src/stores/__tests__/plan-store.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePlanStore } from '@/stores/plan-store';

// ── Shared mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const insert = vi.fn(() => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'v1' }, error: null }) }) }));
  const del = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
  const from = vi.fn((table: string) => ({
    upsert,
    insert,
    delete: del,
    select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  }));
  return { supabase: { from }, isSupabaseConfigured: true };
});

vi.mock('@/lib/sync', () => ({
  fetchPlans: vi.fn().mockResolvedValue([]),
  fetchPlanVersions: vi.fn().mockResolvedValue([]),
  pushPlanVersion: vi.fn().mockResolvedValue({ id: 'v1' }),
  fetchPlanComments: vi.fn().mockResolvedValue([]),
  pushPlanComment: vi.fn().mockResolvedValue(undefined),
  deletePlanComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  tryAccountScopedPath: vi.fn(() => 'notter-ai/u1/cache/plans.json'),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PlanStore', () => {
  beforeEach(() => {
    usePlanStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty state', () => {
    const { plans, currentPlanId, workingDraft, snapshots, comments } = usePlanStore.getState();
    expect(plans).toEqual([]);
    expect(currentPlanId).toBeNull();
    expect(workingDraft).toBe('');
    expect(snapshots).toEqual([]);
    expect(comments).toEqual([]);
  });

  it('applyRemotePlans replaces the plans slice', () => {
    const remote = [
      { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' },
    ];
    usePlanStore.getState().applyRemotePlans(remote);
    expect(usePlanStore.getState().plans).toEqual(remote);
  });

  it('selectPlan sets currentPlanId and workingDraft from the matching plan', () => {
    const plan = { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' };
    usePlanStore.getState().applyRemotePlans([plan]);
    usePlanStore.getState().selectPlan('p1');
    expect(usePlanStore.getState().currentPlanId).toBe('p1');
    expect(usePlanStore.getState().workingDraft).toBe('# A');
  });

  it('updateWorkingDraft changes workingDraft in local state immediately', () => {
    vi.useFakeTimers();
    const plan = { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' };
    usePlanStore.getState().applyRemotePlans([plan]);
    usePlanStore.getState().selectPlan('p1');
    usePlanStore.getState().updateWorkingDraft('# Updated');
    expect(usePlanStore.getState().workingDraft).toBe('# Updated');
  });

  it('reset clears all slices', () => {
    const plan = { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' };
    usePlanStore.getState().applyRemotePlans([plan]);
    usePlanStore.getState().selectPlan('p1');
    usePlanStore.getState().reset();
    const s = usePlanStore.getState();
    expect(s.plans).toEqual([]);
    expect(s.currentPlanId).toBeNull();
    expect(s.workingDraft).toBe('');
    expect(s.snapshots).toEqual([]);
    expect(s.comments).toEqual([]);
  });

  it('applyRemoteSnapshots replaces the snapshots slice', () => {
    const snaps = [
      { id: 'v1', planId: 'p1', userId: 'u1', contentMarkdown: '# v1', parentVersionId: null, source: 'user' as const, sourceActor: null, label: null, createdAt: '' },
    ];
    usePlanStore.getState().applyRemoteSnapshots(snaps);
    expect(usePlanStore.getState().snapshots).toEqual(snaps);
  });

  it('applyRemoteComments replaces the comments slice', () => {
    const comments = [
      { id: 'c1', planId: 'p1', versionId: 'v1', userId: 'u1', authorUserId: 'u1', body: 'Nice', resolved: false, createdAt: '', updatedAt: '' },
    ];
    usePlanStore.getState().applyRemoteComments(comments);
    expect(usePlanStore.getState().comments).toEqual(comments);
  });
});
