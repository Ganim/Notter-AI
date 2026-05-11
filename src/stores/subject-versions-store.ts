// src/stores/subject-versions-store.ts
//
// Thin store keyed by `currentSubjectId`. Holds the version history and
// comment thread for the currently-open subject (markdown note). Replaces
// the older plan-anchored store that hung off a separate plans table; the
// schema pivot in `2026-05-10-subject-versioning.sql` made subjects the
// canonical plan entity, so this store now coordinates with planner-store.
//
// UUID generation: uses crypto.randomUUID() — do NOT add the `uuid` npm package.
//
// No fs cache is needed here — subjects themselves are already cached on disk
// by planner-store, and version/comment history is cheap to refetch on
// subject open.
//
// ── Circular-import note ───────────────────────────────────────────────────
// This store does NOT import planner-store. The data flows the other way:
// planner-store calls `loadForSubject` / `clearSubject` when the user picks a
// subject. To avoid coupling, this store accepts the parent_version_id (i.e.
// the current `subjects.current_version_id`) as an explicit parameter to
// `snapshotCurrent` rather than reading planner-store. The caller is
// responsible for passing the live current version pointer.
import { create } from 'zustand';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchSubjectVersions,
  pushSubjectVersion,
  fetchSubjectComments,
  pushSubjectComment,
  deleteSubjectComment,
  updateSubjectCurrentVersion,
  type SubjectVersionRecord,
  type SubjectCommentRecord,
} from '@/lib/sync';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotArgs {
  contentMarkdown: string;
  source: 'user' | 'ai' | 'import';
  sourceActor?: string | null;
  label?: string | null;
  /**
   * The current `subjects.current_version_id` at the moment of the snapshot.
   * Stored as the new version's `parent_version_id`. Pass `null` for the
   * very first snapshot of a subject. Caller (PlannerTab / planner-store)
   * is the source of truth for this pointer.
   */
  parentVersionId?: string | null;
}

interface SubjectVersionsState {
  currentSubjectId: string | null;
  versions: SubjectVersionRecord[];
  comments: SubjectCommentRecord[];
  /**
   * When non-null, the editor is in "preview mode" showing the contents of
   * this version (read-only). Cleared by `exitPreview()` or implicitly when
   * the user adopts the previewed version.
   */
  previewVersionId: string | null;

  // Boot
  loadForSubject: (subjectId: string) => Promise<void>;
  clearSubject: () => void;

  // Versions
  /**
   * Insert a new subject_version row. Does NOT advance
   * `subjects.current_version_id` — the new row is a "candidate" until the
   * user adopts it. AI-completion paths should use `snapshotAndAdopt`
   * instead, since the user already accepted the AI output by triggering it.
   *
   * Returns the inserted record on success, `null` on failure (no auth, no
   * subject selected, or Supabase rejection).
   */
  snapshotCurrent: (args: SnapshotArgs) => Promise<SubjectVersionRecord | null>;
  /**
   * Convenience for AI-completion flows: snapshots the new content and
   * immediately adopts it as the subject's current version. Errors during
   * adopt are logged but not thrown — the version itself was created.
   */
  snapshotAndAdopt: (args: SnapshotArgs) => Promise<SubjectVersionRecord | null>;

  // Preview / adopt
  enterPreview: (versionId: string) => void;
  exitPreview: () => void;
  /**
   * Set `subjects.current_version_id = versionId` for the active subject.
   * Clears the preview overlay. Returns the adopted version record (so the
   * caller can swap the editor content), or `null` if not found / unauthed.
   */
  adoptVersion: (versionId: string) => Promise<SubjectVersionRecord | null>;

  // Comments
  addComment: (versionId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  toggleResolveComment: (commentId: string) => Promise<void>;

  // Sync
  applyRemoteVersions: (versions: SubjectVersionRecord[]) => void;
  applyRemoteComments: (comments: SubjectCommentRecord[]) => void;

  // Lifecycle
  reset: () => void;
}

// ── Store factory ─────────────────────────────────────────────────────────────

const INITIAL_STATE = {
  currentSubjectId: null as string | null,
  versions: [] as SubjectVersionRecord[],
  comments: [] as SubjectCommentRecord[],
  previewVersionId: null as string | null,
};

export const useSubjectVersionsStore = create<SubjectVersionsState>((set, get) => {
  const store: SubjectVersionsState = {
    ...INITIAL_STATE,

    // ── Boot ─────────────────────────────────────────────────────────────────

    async loadForSubject(subjectId: string) {
      set({
        currentSubjectId: subjectId,
        versions: [],
        comments: [],
        previewVersionId: null,
      });
      const [versions, comments] = await Promise.all([
        fetchSubjectVersions(subjectId),
        fetchSubjectComments(subjectId),
      ]);
      // If the user switched subjects mid-flight, drop these results.
      if (get().currentSubjectId !== subjectId) return;
      set({
        versions: versions ?? [],
        comments: comments ?? [],
      });
    },

    clearSubject() {
      set({
        currentSubjectId: null,
        versions: [],
        comments: [],
        previewVersionId: null,
      });
    },

    // ── Versions ─────────────────────────────────────────────────────────────

    async snapshotCurrent(args: SnapshotArgs) {
      const { currentSubjectId } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentSubjectId || !userId) return null;

      const versionId = crypto.randomUUID();
      const parentVersionId = args.parentVersionId ?? null;
      const sourceActor = args.sourceActor ?? null;
      const label = args.label ?? null;

      const result = await pushSubjectVersion({
        id: versionId,
        subjectId: currentSubjectId,
        contentMarkdown: args.contentMarkdown,
        parentVersionId,
        source: args.source,
        sourceActor,
        label,
      });
      if (!result) return null;

      // Optimistic prepend (newest first) to match fetchSubjectVersions
      // ordering. The realtime subscription will reconcile if needed.
      const newVersion: SubjectVersionRecord = {
        id: versionId,
        subjectId: currentSubjectId,
        userId,
        contentMarkdown: args.contentMarkdown,
        parentVersionId,
        source: args.source,
        sourceActor,
        label,
        createdAt: new Date().toISOString(),
      };
      set((s) => ({ versions: [newVersion, ...s.versions] }));
      return newVersion;
    },

    async snapshotAndAdopt(args: SnapshotArgs) {
      const v = await get().snapshotCurrent(args);
      if (!v) return null;
      // Best-effort adopt; failures here are non-fatal. The version row
      // is already stored — the user can adopt manually from the panel.
      try {
        await get().adoptVersion(v.id);
      } catch (e) {
        console.error('[subject-versions] snapshotAndAdopt: adopt failed', e);
      }
      return v;
    },

    // ── Preview / adopt ──────────────────────────────────────────────────────

    enterPreview(versionId: string) {
      // Idempotent: re-entering the same version is a no-op.
      if (get().previewVersionId === versionId) return;
      set({ previewVersionId: versionId });
    },

    exitPreview() {
      if (get().previewVersionId === null) return;
      set({ previewVersionId: null });
    },

    async adoptVersion(versionId: string) {
      const { currentSubjectId, versions } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentSubjectId || !userId) return null;
      const target = versions.find((v) => v.id === versionId);
      if (!target) {
        console.warn(
          `[subject-versions] adoptVersion(${versionId}): not found in current versions slice`,
        );
        return null;
      }
      await updateSubjectCurrentVersion(userId, currentSubjectId, versionId);
      // Clear any preview — the adopted version IS the new current.
      set({ previewVersionId: null });
      return target;
    },

    // ── Comments ─────────────────────────────────────────────────────────────

    async addComment(versionId: string, body: string) {
      const { currentSubjectId } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentSubjectId || !userId || !body.trim()) return;
      const commentId = crypto.randomUUID();
      const now = new Date().toISOString();
      const newComment: SubjectCommentRecord = {
        id: commentId,
        subjectId: currentSubjectId,
        versionId,
        userId,
        authorUserId: userId,
        body: body.trim(),
        resolved: false,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ comments: [...s.comments, newComment] }));
      await pushSubjectComment({
        id: commentId,
        subjectId: currentSubjectId,
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
      await deleteSubjectComment(commentId, userId);
    },

    async toggleResolveComment(commentId: string) {
      const comment = get().comments.find((c) => c.id === commentId);
      if (!comment) return;
      const updated: SubjectCommentRecord = {
        ...comment,
        resolved: !comment.resolved,
        updatedAt: new Date().toISOString(),
      };
      set((s) => ({
        comments: s.comments.map((c) => (c.id === commentId ? updated : c)),
      }));
      await pushSubjectComment({
        id: updated.id,
        subjectId: updated.subjectId,
        versionId: updated.versionId,
        authorUserId: updated.authorUserId,
        body: updated.body,
        resolved: updated.resolved,
        updatedAt: updated.updatedAt,
      });
    },

    // ── Sync ──────────────────────────────────────────────────────────────────

    applyRemoteVersions(versions: SubjectVersionRecord[]) {
      set({ versions });
    },

    applyRemoteComments(comments: SubjectCommentRecord[]) {
      set({ comments });
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    reset() {
      set(INITIAL_STATE);
    },
  };

  // Register with M1 account-switch registry.
  registerResettableStore(() => store.reset());

  return store;
});
