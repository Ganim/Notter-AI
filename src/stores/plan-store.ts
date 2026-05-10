// src/stores/plan-store.ts
//
// UUID generation: uses crypto.randomUUID() to match the rest of the codebase
// (board-store, action-processor). Do NOT add the `uuid` npm package — it is
// not a dep and there is no need to introduce one.
import { create } from 'zustand';
import { makeDebouncedSync } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { tryAccountScopedPath } from '@/lib/accounts/account-paths';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchPlans,
  fetchPlanVersions,
  pushPlanVersion,
  fetchPlanComments,
  pushPlanComment,
  deletePlanComment,
  type PlanRecord,
  type PlanVersionRecord,
  type PlanCommentRecord,
} from '@/lib/sync';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { BaseDirectory, readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';

// ── Types ────────────────────────────────────────────────────────────────────

interface PlanState {
  plans: PlanRecord[];
  currentPlanId: string | null;
  workingDraft: string;
  snapshots: PlanVersionRecord[];
  comments: PlanCommentRecord[];

  // Boot
  load: (userId: string) => Promise<void>;

  // Plan CRUD
  createPlan: (title: string) => Promise<void>;
  deletePlan: (planId: string) => Promise<void>;
  selectPlan: (planId: string) => Promise<void>;
  renamePlan: (planId: string, title: string) => Promise<void>;

  // Working draft
  updateWorkingDraft: (content: string) => void;

  // Snapshots
  snapshotCurrent: (label?: string) => Promise<void>;
  loadSnapshot: (versionId: string) => void;

  // Comments
  addComment: (versionId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  toggleResolveComment: (commentId: string) => Promise<void>;

  // Sync
  applyRemotePlans: (plans: PlanRecord[]) => void;
  applyRemoteSnapshots: (snapshots: PlanVersionRecord[]) => void;
  applyRemoteComments: (comments: PlanCommentRecord[]) => void;

  // Lifecycle
  flush: () => Promise<void>;
  reset: () => void;
}

// ── Debounced sync for working_content ───────────────────────────────────────
// The payload carries { planId, content } so the push function can upsert only
// the affected plan row. userId is read at fire time from auth-store (M1 pattern).

const draftSync = makeDebouncedSync<{ planId: string; content: string }>(
  async (userId, payload) => {
    if (!isSupabaseConfigured) return;
    const { error } = await supabase
      .from('plans')
      .update({ working_content: payload.content, updated_at: new Date().toISOString() })
      .eq('id', payload.planId)
      .eq('user_id', userId);
    if (error) console.error('[plan-store] debounced draft push failed:', error);
  },
  1000,
);

// ── Store factory ─────────────────────────────────────────────────────────────

const INITIAL_STATE = {
  plans: [] as PlanRecord[],
  currentPlanId: null as string | null,
  workingDraft: '',
  snapshots: [] as PlanVersionRecord[],
  comments: [] as PlanCommentRecord[],
};

export const usePlanStore = create<PlanState>((set, get) => {
  const store: PlanState = {
    ...INITIAL_STATE,

    // ── Boot ─────────────────────────────────────────────────────────────────

    async load(userId: string) {
      const remote = await fetchPlans(userId);
      if (remote && remote.length > 0) {
        set({ plans: remote });
        // Persist to local cache for offline/fast-boot
        const cachePath = tryAccountScopedPath('cache/plans.json');
        if (cachePath) {
          try {
            const dir = cachePath.substring(0, cachePath.lastIndexOf('/'));
            const dirExists = await exists(dir, { baseDir: BaseDirectory.AppLocalData });
            if (!dirExists) await mkdir(dir, { baseDir: BaseDirectory.AppLocalData, recursive: true });
            await writeTextFile(cachePath, JSON.stringify(remote), { baseDir: BaseDirectory.AppLocalData });
          } catch (e) {
            console.error('[plan-store] cache write failed:', e);
          }
        }
      } else {
        // Attempt local cache for offline fast-boot
        const cachePath = tryAccountScopedPath('cache/plans.json');
        if (cachePath) {
          try {
            const cacheExists = await exists(cachePath, { baseDir: BaseDirectory.AppLocalData });
            if (cacheExists) {
              const raw = await readTextFile(cachePath, { baseDir: BaseDirectory.AppLocalData });
              set({ plans: JSON.parse(raw) });
            }
          } catch (e) {
            console.error('[plan-store] cache read failed:', e);
          }
        }
      }
    },

    // ── Plan CRUD ────────────────────────────────────────────────────────────

    async createPlan(title: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || !isSupabaseConfigured) return;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const newPlan: PlanRecord = {
        id,
        userId,
        title: title.trim() || 'Untitled plan',
        workingContent: '',
        currentSnapshotId: null,
        createdAt: now,
        updatedAt: now,
      };
      // Optimistic local insert
      set((s) => ({ plans: [newPlan, ...s.plans] }));
      // Push to Supabase
      const { error } = await supabase.from('plans').insert({
        id,
        user_id: userId,
        title: newPlan.title,
        working_content: '',
      });
      if (error) {
        console.error('[plan-store] createPlan failed:', error);
        // Revert optimistic insert
        set((s) => ({ plans: s.plans.filter((p) => p.id !== id) }));
      }
    },

    async deletePlan(planId: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || !isSupabaseConfigured) return;
      // Optimistic local removal
      const before = get().plans;
      const wasCurrent = get().currentPlanId === planId;
      set((s) => ({
        plans: s.plans.filter((p) => p.id !== planId),
        currentPlanId: wasCurrent ? null : s.currentPlanId,
        workingDraft: wasCurrent ? '' : s.workingDraft,
        snapshots: wasCurrent ? [] : s.snapshots,
        comments: wasCurrent ? [] : s.comments,
      }));
      const { error } = await supabase
        .from('plans')
        .delete()
        .eq('id', planId)
        .eq('user_id', userId);
      if (error) {
        console.error('[plan-store] deletePlan failed:', error);
        // Revert
        set({ plans: before });
      }
    },

    async selectPlan(planId: string) {
      const plan = get().plans.find((p) => p.id === planId);
      if (!plan) return;
      set({
        currentPlanId: planId,
        workingDraft: plan.workingContent,
        snapshots: [],
        comments: [],
      });
      // Fetch snapshots + comments for the selected plan
      const [versions, comments] = await Promise.all([
        fetchPlanVersions(planId),
        fetchPlanComments(planId),
      ]);
      set({
        snapshots: versions ?? [],
        comments: comments ?? [],
      });
    },

    async renamePlan(planId: string, title: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || !isSupabaseConfigured) return;
      set((s) => ({
        plans: s.plans.map((p) =>
          p.id === planId ? { ...p, title, updatedAt: new Date().toISOString() } : p,
        ),
      }));
      const { error } = await supabase
        .from('plans')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', planId)
        .eq('user_id', userId);
      if (error) console.error('[plan-store] renamePlan failed:', error);
    },

    // ── Working draft ─────────────────────────────────────────────────────────

    updateWorkingDraft(content: string) {
      const planId = get().currentPlanId;
      if (!planId) return;
      set((s) => ({
        workingDraft: content,
        plans: s.plans.map((p) =>
          p.id === planId ? { ...p, workingContent: content, updatedAt: new Date().toISOString() } : p,
        ),
      }));
      draftSync.schedule({ planId, content });
    },

    // ── Snapshots ─────────────────────────────────────────────────────────────

    async snapshotCurrent(label?: string) {
      const { currentPlanId, workingDraft, snapshots } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentPlanId || !userId) return;

      const parentVersionId = snapshots.length > 0 ? snapshots[0].id : null;
      const versionId = crypto.randomUUID();

      const result = await pushPlanVersion({
        id: versionId,
        planId: currentPlanId,
        contentMarkdown: workingDraft,
        parentVersionId,
        source: 'user',
        sourceActor: null,
        label: label ?? null,
      });
      if (!result) return;

      // Update plans.current_snapshot_id
      const { error } = await supabase
        .from('plans')
        .update({
          current_snapshot_id: versionId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentPlanId)
        .eq('user_id', userId);
      if (error) console.error('[plan-store] snapshotCurrent update snapshot_id failed:', error);

      // Optimistic prepend to snapshots slice
      const newSnapshot: PlanVersionRecord = {
        id: versionId,
        planId: currentPlanId,
        userId,
        contentMarkdown: workingDraft,
        parentVersionId,
        source: 'user',
        sourceActor: null,
        label: label ?? null,
        createdAt: new Date().toISOString(),
      };
      set((s) => ({
        snapshots: [newSnapshot, ...s.snapshots],
        plans: s.plans.map((p) =>
          p.id === currentPlanId
            ? { ...p, currentSnapshotId: versionId, updatedAt: new Date().toISOString() }
            : p,
        ),
      }));
    },

    loadSnapshot(versionId: string) {
      const snap = get().snapshots.find((v) => v.id === versionId);
      if (!snap) return;
      // Load snapshot content into the working draft; does NOT persist to Supabase
      // automatically. The 1s debounce will fire and write working_content.
      // M3 NOTE: spec §6.5 also wants `plans.current_snapshot_id` to advance to
      // `versionId` when the user adopts an AI revision. That part is M3 work
      // (it ties into the "Codex posted v4" toast flow and post_revision tool);
      // intentionally not implemented here.
      get().updateWorkingDraft(snap.contentMarkdown);
    },

    // ── Comments ──────────────────────────────────────────────────────────────

    async addComment(versionId: string, body: string) {
      const { currentPlanId } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentPlanId || !userId || !body.trim()) return;
      const commentId = crypto.randomUUID();
      const now = new Date().toISOString();
      const newComment: PlanCommentRecord = {
        id: commentId,
        planId: currentPlanId,
        versionId,
        userId,
        authorUserId: userId,
        body: body.trim(),
        resolved: false,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ comments: [...s.comments, newComment] }));
      await pushPlanComment({
        id: commentId,
        planId: currentPlanId,
        versionId,
        authorUserId: userId,
        body: body.trim(),
        resolved: false,
        updatedAt: now,
      });
    },

    async deleteComment(commentId: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      set((s) => ({ comments: s.comments.filter((c) => c.id !== commentId) }));
      await deletePlanComment(commentId, userId);
    },

    async toggleResolveComment(commentId: string) {
      const comment = get().comments.find((c) => c.id === commentId);
      if (!comment) return;
      const updated = { ...comment, resolved: !comment.resolved, updatedAt: new Date().toISOString() };
      set((s) => ({
        comments: s.comments.map((c) => (c.id === commentId ? updated : c)),
      }));
      await pushPlanComment({
        id: updated.id,
        planId: updated.planId,
        versionId: updated.versionId,
        authorUserId: updated.authorUserId,
        body: updated.body,
        resolved: updated.resolved,
        updatedAt: updated.updatedAt,
      });
    },

    // ── Sync ──────────────────────────────────────────────────────────────────

    applyRemotePlans(plans: PlanRecord[]) {
      set({ plans });
    },

    applyRemoteSnapshots(snapshots: PlanVersionRecord[]) {
      set({ snapshots });
    },

    applyRemoteComments(comments: PlanCommentRecord[]) {
      set({ comments });
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async flush() {
      await draftSync.flush();
    },

    reset() {
      set(INITIAL_STATE);
    },
  };

  // Register with M1 account-switch registry
  registerResettableStore(() => store.reset());

  return store;
});
