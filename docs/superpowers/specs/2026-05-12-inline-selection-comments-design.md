# Inline Selection Comments — Design Spec

**Date:** 2026-05-12
**Status:** Approved (autonomy mode — user OK'd full implementation without per-section gates)
**Pivot context:** Phase 2 work on the Planner-only main branch; comments are the input that "motivates" the next AI-generated version.

## Goal

Let the user select any snippet of a subject's markdown body, attach a comment to that exact snippet, edit it, see it in the side panel with the quoted text + author + time, and have the comment payload (including the quote) reach external CLIs via the in-process MCP server. Comments are the human review signal feeding the AI roundtrip.

## Locked decisions (from brainstorm)

| Dimension | Choice |
|---|---|
| Anchor target | **Live working draft.** No "version-snapshot" model — the anchor floats on the current `subjects.content`. |
| Orphan behavior | **Auto-archive silently.** When the quote+context can't be located in the current draft, set `archived = true`. Visible only when the panel's "Show archived" toggle is on. |
| Selection trigger | **Floating "💬 Comentar" button** that appears next to the selection. Click → expands inline to a textarea + Save / Cancel. |
| Authorship metadata | `author_user_id` (already there) + new `author_display_name` denormalized at insert from `useAuthStore.user.user_metadata.display_name ?? full_name ?? email`. |
| Edit | Inline pencil → textarea swap inside the comment card. Updates `body` + `updated_at`. Anchor never changes. |

## Schema migration (`2026-05-12-comment-anchors.sql`)

```sql
alter table subject_comments
  add column anchor_quote   text,
  add column anchor_prefix  text,
  add column anchor_suffix  text,
  add column archived       boolean not null default false,
  add column author_display_name text;

create index subject_comments_archived_idx on subject_comments(archived);
```

- `anchor_quote` NULL = pre-feature "general" comment (none in prod yet, table is empty).
- `anchor_prefix` / `anchor_suffix` = up to 32 chars of context around the quote, used to disambiguate when the same quote appears multiple times.
- `archived` is set client-side when an anchor can't be resolved in the current draft. We never delete the row — keeping the original quote + body is useful AI context even after the user has edited the source text.

## Anchor lookup

`src/lib/plans/anchor.ts` — pure function:

```ts
findAnchor(content: string, anchor: { quote, prefix, suffix }): { start, end } | null
```

Algorithm (in order):
1. Search for `prefix + quote + suffix` in content. If exactly one match, return its range.
2. Search for `quote` alone. If exactly one match, return its range.
3. Search for `quote` with at least one of {prefix, suffix} as a context check. Return the first match where context aligns.
4. Otherwise return `null` → caller marks the comment archived.

Trivially cheap (string.indexOf), runs on every draft change debounced ~400ms.

## Storage normalization

When a comment is created from a selection:
- `anchor_quote` = selected text, sliced to first 500 chars max (very long quotes are an anti-pattern).
- `anchor_prefix` = up to 32 chars in `content` immediately before selection start (trim word boundary if mid-word).
- `anchor_suffix` = up to 32 chars in `content` immediately after selection end.

## Auto-snapshot guard

`subject_comments.version_id` stays NOT NULL. If the subject has no `current_version_id` when the user creates the first comment, the store transparently calls `snapshotAndAdopt({ source: 'user', label: t('plans.auto_snapshot_for_comment_label') })` and uses the resulting version's id. The user never sees the gate that exists today ("create a version first").

## UI components

```
src/components/plans/
  InlineCommentTrigger.tsx  -- floating "💬 Comentar" button + inline composer
  CommentCard.tsx            -- single card (quote + author + time + body + actions)
  CommentsPanel.tsx          -- list (existing, revamped)
  useAnchorHighlights.ts     -- hook computing decoration ranges from comments
```

### Selection trigger

Watches Monaco's `onDidChangeCursorSelection` (edit mode) and `document.selectionchange` scoped to the markdown preview container (view mode). On non-empty selection → renders a small popover anchored to the selection's bounding rect (right-aligned to selection end). Single button: `💬 Comentar`. Click → swaps to a 3-row textarea + Save (Cmd/Ctrl+Enter) + Cancel (Esc). Save → calls `subject-versions-store.addComment({ versionId: current, body, anchor })`.

### Comment card

```
┌────────────────────────────────────────────┐
│ Guilherme · há 5 min                  ⋯    │
│ ▎ "trecho citado do markdown..."           │
│ comentário do usuário aqui                  │
│                                             │
│ [resolve] [edit] [delete]                   │
└────────────────────────────────────────────┘
```

The quote uses a left border (Tailwind `border-l-2 border-primary/40 pl-2`) and `italic text-muted-foreground`. Long quotes truncate at ~120 chars with `…` and full-quote shown on hover (title attr). Click on the quoted region scrolls the editor to the anchor and flashes the highlight (1.2s).

Edit mode: pencil swaps body to a textarea; Save updates `body` + `updated_at`. Cancel reverts. Anchor never changes from edit.

### Highlights

Edit mode (Monaco): on every `comments` / `subjectContent` change, compute `IModelDecoration[]` from non-archived anchors and call `editor.deltaDecorations(prev, next)`. Class: `notter-anchor-highlight` → `bg-amber-100 dark:bg-amber-500/15`. Hover/click handler scrolls comments panel to that comment.

View mode (ReactMarkdown): post-process — wrap the matching ranges with `<mark class="notter-anchor-highlight">`. Done by walking the rendered output's text nodes after each render and splitting/wrapping. We accept that this won't survive markdown that splits the quoted text across two formatting boundaries (e.g., quote spans a `**bold**` boundary) — in that case the highlight is silently skipped for that comment in view mode but the card still renders. (Edit mode highlight always works because Monaco operates on raw text.)

## MCP changes

`src-tauri/src/mcp/tools.rs` — `list_comments` query:

```diff
- select=id,version_id,body,resolved,author_user_id,created_at
+ select=id,version_id,body,anchor_quote,anchor_prefix,anchor_suffix,resolved,archived,author_user_id,author_display_name,created_at,updated_at
```

By default `archived=false` rows are returned; an optional `include_archived` param defaults to false (new param). External CLIs see comments with the original quoted snippet, so the AI prompt can read "user wrote 'X' on the snippet 'Y'" without resolving anchors itself.

## Mobile

The selection trigger works on touch (uses bounding rect of selection, same as Notion). The comments side panel doesn't render on small screens today; a future patch will expose comments via a full-screen modal triggered from the editor header. Out of scope for this spec.

## Tests

- Unit: `findAnchor` happy path, prefix-suffix disambiguation, quote-not-found → null, multiple matches.
- Unit: anchor encoder (`buildAnchorFromSelection`) — clipping, prefix/suffix length cap.
- Smoke: existing `subject-versions-store` tests stay green.

## Out of scope

- Comments on snapshotted historical versions in preview mode (read-only view; not interactive).
- Threaded replies.
- @-mentions / multi-user collaboration (Pillar 3, deferred).
- Mobile comments modal (see above).
