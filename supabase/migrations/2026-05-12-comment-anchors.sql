-- Inline selection comments (Phase 2 / 2026-05-12).
--
-- Adds anchor metadata to subject_comments so each comment can reference an
-- exact snippet of the subject's markdown body. Anchor uses a quoted text +
-- short prefix/suffix context (32 chars each) to survive draft edits that
-- shift offsets. When the quote can't be located in the current draft the
-- client sets archived = true (soft delete; the row is preserved for AI
-- context).
--
-- author_display_name is denormalized at INSERT from the auth user metadata
-- (display_name → full_name → email fallback) so the MCP `list_comments`
-- response can ship a human-readable author without resolving auth.users at
-- read time (RLS + perf).
alter table subject_comments
  add column anchor_quote   text,
  add column anchor_prefix  text,
  add column anchor_suffix  text,
  add column archived       boolean not null default false,
  add column author_display_name text;

create index subject_comments_archived_idx on subject_comments(archived);
