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
import type { CommentAnchor } from '@/lib/plans/anchor';
import type { User } from '@supabase/supabase-js';

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

export interface AddCommentArgs {
  body: string;
  anchor: CommentAnchor;
  /** Current `subjects.current_version_id`. If null, the store auto-snapshots `contentForSnapshot` first. */
  versionId: string | null;
  /** Used only when `versionId` is null — content of the working draft to snapshot as v0. */
  contentForSnapshot: string;
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
  /**
   * Create a new anchored comment. If `versionId` is null, the store first
   * snapshots `contentForSnapshot` as a synthetic v0 (source 'user',
   * auto-adopted) and uses that id. This makes the "no version exists yet"
   * gate invisible to the user.
   *
   * Returns the inserted comment on success, `null` on failure (no auth,
   * no subject, snapshot failure, or empty body).
   */
  addComment: (args: AddCommentArgs) => Promise<SubjectCommentRecord | null>;
  editComment: (commentId: string, body: string) => Promise<void>;
  setCommentArchived: (commentId: string, archived: boolean) => Promise<void>;
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

/**
 * Best-effort human-readable name for the current auth user. Used to
 * denormalize author identity on each new comment so the MCP `list_comments`
 * payload — and the side panel — render a real name instead of a UUID.
 */
function resolveDisplayName(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.display_name === 'string' && meta.display_name) ||
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    user.email ||
    null;
  return name || null;
}

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

    async addComment(args: AddCommentArgs) {
      const { currentSubjectId } = get();
      const user = useAuthStore.getState().user;
      const body = args.body.trim();
      if (!currentSubjectId || !user || !body) return null;

      // Auto-snapshot the working draft if the subject has no current version
      // yet. This hides the "no version exists" gate from the comment UX —
      // the user shouldn't have to know about snapshots to leave feedback.
      let versionId = args.versionId;
      if (!versionId) {
        const snap = await get().snapshotAndAdopt({
          contentMarkdown: args.contentForSnapshot,
          source: 'user',
          label: 'auto: first comment',
        });
        if (!snap) return null;
        versionId = snap.id;
      }

      const commentId = crypto.randomUUID();
      const now = new Date().toISOString();
      const newComment: SubjectCommentRecord = {
        id: commentId,
        subjectId: currentSubjectId,
        versionId,
        userId: user.id,
        authorUserId: user.id,
        authorDisplayName: resolveDisplayName(user),
        body,
        resolved: false,
        archived: false,
        anchorQuote: args.anchor.quote,
        anchorPrefix: args.anchor.prefix,
        anchorSuffix: args.anchor.suffix,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ comments: [...s.comments, newComment] }));
      await pushSubjectComment({
        id: commentId,
        subjectId: currentSubjectId,
        versionId,
        authorUserId: user.id,
        authorDisplayName: newComment.authorDisplayName,
        body,
        resolved: false,
        archived: false,
        anchorQuote: newComment.anchorQuote,
        anchorPrefix: newComment.anchorPrefix,
        anchorSuffix: newComment.anchorSuffix,
        updatedAt: now,
      });
      return newComment;
    },

    async editComment(commentId: string, body: string) {
      const trimmed = body.trim();
      if (!trimmed) return;
      const comment = get().comments.find((c) => c.id === commentId);
      if (!comment) return;
      const userId = useAuthStore.getState().user?.id;
      // Only the author may edit.
      if (!userId || userId !== comment.authorUserId) return;
      const updated: SubjectCommentRecord = {
        ...comment,
        body: trimmed,
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
        authorDisplayName: updated.authorDisplayName,
        body: updated.body,
        resolved: updated.resolved,
        archived: updated.archived,
        anchorQuote: updated.anchorQuote,
        anchorPrefix: updated.anchorPrefix,
        anchorSuffix: updated.anchorSuffix,
        updatedAt: updated.updatedAt,
      });
    },

    async setCommentArchived(commentId: string, archived: boolean) {
      const comment = get().comments.find((c) => c.id === commentId);
      if (!comment || comment.archived === archived) return;
      const updated: SubjectCommentRecord = {
        ...comment,
        archived,
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
        authorDisplayName: updated.authorDisplayName,
        body: updated.body,
        resolved: updated.resolved,
        archived: updated.archived,
        anchorQuote: updated.anchorQuote,
        anchorPrefix: updated.anchorPrefix,
        anchorSuffix: updated.anchorSuffix,
        updatedAt: updated.updatedAt,
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
        authorDisplayName: updated.authorDisplayName,
        body: updated.body,
        resolved: updated.resolved,
        archived: updated.archived,
        anchorQuote: updated.anchorQuote,
        anchorPrefix: updated.anchorPrefix,
        anchorSuffix: updated.anchorSuffix,
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
