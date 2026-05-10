// src/stores/subject-versions-store.ts
//
// Thin store keyed by `currentSubjectId`. Holds the version history and
// comment thread for the currently-open subject (markdown note). Replaces
// the older plan-anchored store that hung off a separate plans table; the
// schema pivot in `2026-05-10-subject-versioning.sql` made subjects the
// canonical plan entity, so this store now coordinates with planner-store.
//
// UUID generation: uses crypto.randomUUID() to match the rest of the codebase
// (board-store, action-processor). Do NOT add the `uuid` npm package.
//
// No fs cache is needed here — subjects themselves are already cached on disk
// by planner-store, and version/comment history is cheap to refetch on
// subject open.
import { create } from 'zustand';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchSubjectVersions,
  pushSubjectVersion,
  fetchSubjectComments,
  pushSubjectComment,
  deleteSubjectComment,
  type SubjectVersionRecord,
  type SubjectCommentRecord,
} from '@/lib/sync';

// ── Types ────────────────────────────────────────────────────────────────────

interface SubjectVersionsState {
  currentSubjectId: string | null;
  versions: SubjectVersionRecord[];
  comments: SubjectCommentRecord[];

  // Boot
  loadForSubject: (subjectId: string) => Promise<void>;
  clearSubject: () => void;

  // Versions
  snapshotCurrent: (contentMarkdown: string, label?: string) => Promise<void>;
  // Backwards-compat no-op kept until P5 polishes the panels. The old store
  // exposed loadSnapshot(versionId) to revert the working draft to a past
  // version; in the subject-anchored model this responsibility moves to the
  // editor (planner-store.subjectContent) and is not the versions store's
  // job. P5 will rewire the panel buttons accordingly.
  loadSnapshot: (versionId: string) => void;

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
};

export const useSubjectVersionsStore = create<SubjectVersionsState>((set, get) => {
  const store: SubjectVersionsState = {
    ...INITIAL_STATE,

    // ── Boot ─────────────────────────────────────────────────────────────────

    async loadForSubject(subjectId: string) {
      set({ currentSubjectId: subjectId, versions: [], comments: [] });
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
      set({ currentSubjectId: null, versions: [], comments: [] });
    },

    // ── Versions ─────────────────────────────────────────────────────────────

    async snapshotCurrent(contentMarkdown: string, label?: string) {
      const { currentSubjectId, versions } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentSubjectId || !userId) return;

      const parentVersionId = versions.length > 0 ? versions[0].id : null;
      const versionId = crypto.randomUUID();

      const result = await pushSubjectVersion({
        id: versionId,
        subjectId: currentSubjectId,
        contentMarkdown,
        parentVersionId,
        source: 'user',
        sourceActor: null,
        label: label ?? null,
      });
      if (!result) return;

      // Optimistic prepend (newest first) to match fetchSubjectVersions
      // ordering.
      const newVersion: SubjectVersionRecord = {
        id: versionId,
        subjectId: currentSubjectId,
        userId,
        contentMarkdown,
        parentVersionId,
        source: 'user',
        sourceActor: null,
        label: label ?? null,
        createdAt: new Date().toISOString(),
      };
      set((s) => ({ versions: [newVersion, ...s.versions] }));
    },

    loadSnapshot(_versionId: string) {
      // Intentional no-op. P5 will wire the panel button to the editor.
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
