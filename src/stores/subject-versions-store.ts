// src/stores/subject-versions-store.ts
//
// Thin store keyed by `currentSubjectId`. Holds the version history and
// comment thread for the currently-open subject (markdown note).
//
// Versioning model (2026-05-14 overhaul, branch fix/versioning-overhaul):
// every write goes through the atomic `commit_subject_version` RPC, which
// inserts the version row AND moves `subjects.content` +
// `subjects.current_version_id` together. The invariant
//   subjects.content == current_version.content_markdown
// is enforced by construction. Adopting an older version creates a NEW
// copy-version with that version's content (and parent_version_id pointing
// back to the adopted row) so the timeline stays linear and auditable.
//
// ── Circular-import note ───────────────────────────────────────────────────
// This store does NOT import planner-store. planner-store drives this one by
// calling `loadForSubject` / `clearSubject` when the user picks a subject.
import { create } from 'zustand';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchSubjectVersions,
  commitSubjectVersion,
  fetchSubjectComments,
  pushSubjectComment,
  deleteSubjectComment,
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
   * very first snapshot of a subject. Caller (PlannerTab / planner-store) is
   * the source of truth for this pointer.
   */
  parentVersionId?: string | null;
  /**
   * Coalesce window in seconds. When > 0 and the most recent same-source
   * version is within the window, the RPC updates that row's content in
   * place instead of inserting a new one. Used to keep autosave from
   * flooding the table — e.g. 60s for keystroke-driven saves. Defaults to
   * 0 (always insert a new row).
   */
  coalesceWindowSecs?: number;
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
  /**
   * UI-only: the comment currently in "focus" — set when the user clicks an
   * anchored highlight in the editor or a comment card's quote in the side
   * panel. Drives the ring on the comment card AND the brighter variant of
   * the editor highlight. Resets to null on subject change.
   */
  activeCommentId: string | null;

  // Boot
  loadForSubject: (subjectId: string) => Promise<void>;
  clearSubject: () => void;

  // Versions
  /**
   * Commit a new version. Goes through `commit_subject_version` so it ALSO
   * sets `subjects.content` + `subjects.current_version_id` atomically.
   * With `coalesceWindowSecs > 0`, the RPC may update the most recent same-
   * source version in place (autosave-style). Returns the version record
   * that now holds the content, or `null` on failure.
   */
  snapshotCurrent: (args: SnapshotArgs) => Promise<SubjectVersionRecord | null>;
  /**
   * Backward-compatible alias for `snapshotCurrent` — since every commit now
   * adopts atomically, the two operations are identical. Kept for callsites
   * that read better with the explicit name.
   */
  snapshotAndAdopt: (args: SnapshotArgs) => Promise<SubjectVersionRecord | null>;

  // Preview / adopt
  enterPreview: (versionId: string) => void;
  exitPreview: () => void;
  /**
   * Adopt an older version. Creates a NEW copy-version with that version's
   * content (source='user', parent_version_id = adopted.id), which becomes
   * the new current. The original version stays untouched in history —
   * timeline reads as "linear with revert points". Returns the newly-created
   * version, or `null` on failure.
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

  // UI state
  setActiveCommentId: (id: string | null) => void;

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
  activeCommentId: null as string | null,
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
        activeCommentId: null,
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
        activeCommentId: null,
      });
    },

    // ── Versions ─────────────────────────────────────────────────────────────

    async snapshotCurrent(args: SnapshotArgs) {
      const { currentSubjectId } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentSubjectId || !userId) return null;

      const parentVersionId = args.parentVersionId ?? null;
      const sourceActor = args.sourceActor ?? null;
      const label = args.label ?? null;
      const coalesceWindowSecs = args.coalesceWindowSecs ?? 0;

      const newId = await commitSubjectVersion({
        subjectId: currentSubjectId,
        content: args.contentMarkdown,
        source: args.source,
        sourceActor,
        label,
        parentVersionId,
        coalesceWindowSecs,
      });
      if (!newId) return null;

      const nowIso = new Date().toISOString();
      const committed: SubjectVersionRecord = {
        id: newId,
        subjectId: currentSubjectId,
        userId,
        contentMarkdown: args.contentMarkdown,
        parentVersionId,
        source: args.source,
        sourceActor,
        label,
        createdAt: nowIso,
      };
      // Coalesced writes can return an existing row's id — replace in place
      // when found, otherwise prepend (matches fetchSubjectVersions newest-
      // first ordering). Realtime reconciles further.
      set((s) => {
        const idx = s.versions.findIndex((v) => v.id === newId);
        if (idx >= 0) {
          const next = s.versions.slice();
          next[idx] = { ...next[idx], ...committed, createdAt: next[idx].createdAt };
          return { versions: next };
        }
        return { versions: [committed, ...s.versions] };
      });
      return committed;
    },

    async snapshotAndAdopt(args: SnapshotArgs) {
      // The RPC always adopts, so this is now identical to snapshotCurrent.
      return get().snapshotCurrent(args);
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
      if (!currentSubjectId) return null;
      const target = versions.find((v) => v.id === versionId);
      if (!target) {
        console.warn(
          `[subject-versions] adoptVersion(${versionId}): not found in current versions slice`,
        );
        return null;
      }
      // Adopt creates a new copy-version: the original stays in history,
      // a fresh row carries the same content forward as the new current.
      // Label is auto-generated (caller can rename via a future "edit
      // label" flow). parent points back to the adopted row so the chain
      // reflects "user reverted to X at time T".
      const adoptLabel = `Revertido para ${target.label ?? `v${target.id.slice(0, 6)}`}`;
      // source_actor='adopt' keeps subsequent autosaves (source_actor=null)
      // from coalescing INTO this revert checkpoint and rewriting its label
      // / content; the next autosave will start a fresh row instead.
      const committed = await get().snapshotCurrent({
        contentMarkdown: target.contentMarkdown,
        source: 'user',
        sourceActor: 'adopt',
        label: adoptLabel,
        parentVersionId: target.id,
        coalesceWindowSecs: 0,
      });
      if (!committed) return null;
      // Clear preview — the new current IS the adopted content.
      set({ previewVersionId: null });
      return committed;
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

    // ── UI state ──────────────────────────────────────────────────────────────

    setActiveCommentId(id: string | null) {
      if (get().activeCommentId === id) return;
      set({ activeCommentId: id });
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
