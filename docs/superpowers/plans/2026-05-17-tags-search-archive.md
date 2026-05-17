# Tags, Search & Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three coupled features from spec `2026-05-14-tags-search-archive-design.md` — Linear-style stable identifiers (`flow-3` = `projects.tag` + `subjects.seq`), a workspace-scoped search field, and project-level archive UI — plus the MCP enrichment touches in spec §13.

**Architecture:** One Postgres migration adds `projects.tag`, `projects.next_subject_seq`, `subjects.seq`, two SECURITY DEFINER RPCs (`create_subject`, `gen_unique_tag`), and backfills existing rows. A TS helper `subjectIdentifier(subject, project)` renders the displayed identifier; chip color hashes deterministically from the tag string. Sync layer adds the new columns to pull/push and routes subject creation through the RPC. Planner store gains slices for `searchQuery`, `searchMode`, `archivedProjects`. UI changes are scoped to the existing `PlannerTab.tsx` sidebar plus small new components for chips/dialogs/search. MCP layer enriches subject responses with `identifier` and reroutes `save_subject` through `create_subject` RPC.

**Tech Stack:** Postgres (Supabase RLS), TypeScript, React + Zustand, Vitest, Rust (Tauri/axum MCP server), PowerShell smoke harness.

**Baseline:** commit `0617b88` on `main` (spec amended 2026-05-17). Multi-user workspaces Plan 2, MCP expansion (17/17 tools), and `mcp:workspace-switch` event are all live.

**Pre-existing infrastructure (do not re-add):**
- `projects.archived_at`, `subjects.archived_at`, `workspaces.archived_at` and the `*_active_idx` partial indexes already exist from `supabase/migrations/2026-05-14-mcp-expansion.sql`. This plan adds only `tag` / `next_subject_seq` / `seq` columns.
- MCP `archive_resource` / `restore_resource` tools already write `archived_at`. The UI archive tasks consume the existing tool surface; no new MCP tools are needed for archive.

---

## File structure

**Create:**
- `supabase/migrations/2026-05-17-tags-search-archive.sql`
- `src/lib/identifiers.ts`
- `src/lib/__tests__/identifiers.test.ts`
- `src/components/dialogs/EditTagDialog.tsx`
- `src/components/dialogs/__tests__/EditTagDialog.test.tsx`
- `src/components/sidebar/SidebarSearch.tsx`
- `src/components/sidebar/__tests__/SidebarSearch.test.tsx`
- `src/components/sidebar/ArchivedToggle.tsx`
- `src/components/sidebar/TagChip.tsx`
- `scripts/smoke-tags-search-archive.ps1`

**Modify:**
- `src/lib/sync.ts` — add tag/seq/archived_at to pull/push; add `createSubjectViaRpc`, `genUniqueTag`, `updateProjectTag`, `archiveProject`, `unarchiveProject` wrappers
- `src/lib/__tests__/sync.test.ts` (if missing, create alongside)
- `src/stores/planner-store.ts` — `searchQuery`, `searchMode`, `archivedProjects` slices + selectors + mutations
- `src/stores/__tests__/planner-store.test.ts` (extend)
- `src/components/PlannerTab.tsx` — wire TagChip + identifier rendering, mount SidebarSearch + ArchivedToggle, tag field in NewProjectDialog
- `src-tauri/src/mcp/tools.rs` — enrich `list_subjects` / `get_subject` / `post_subject_revision` / `save_subject` with `identifier`; reroute `save_subject` through RPC; enrich `list_projects` with `tag`
- `src-tauri/tests/` (Rust unit tests inline in tools.rs `#[cfg(test)]` per existing pattern)
- `scripts/smoke-mcp-v2.ps1` — assert new fields
- `src/i18n/locales/en.json`, `src/i18n/locales/pt-BR.json`

---

## Phase 0 — i18n keys

Small isolated change. Lands all UI strings up front so later UI tasks don't fight with localization.

### Task 0.1: Add tag/search/archive i18n keys to both locales

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/pt-BR.json`

- [ ] **Step 1: Add keys to `pt-BR.json` inside the existing `"workspaces"` block sibling, in a new `"tags"` block at top level**

Insert before the closing `}` of the JSON root. Find the last top-level block (likely `"plans"` or similar) and add after it:

```json
  "tags": {
    "edit_title": "Editar tag",
    "edit_current": "Tag atual:",
    "edit_new_label": "Nova tag:",
    "edit_warning": "Atenção: links externos a {{old}}-N deixarão de resolver.",
    "edit_save": "Salvar",
    "edit_cancel": "Cancelar",
    "edit_failed": "Falha ao atualizar tag",
    "edit_invalid_shape": "Tag deve ser 2–8 caracteres minúsculos (a-z, 0-9)",
    "edit_reserved": "Tag reservada — escolha outra",
    "edit_duplicate": "Esta tag já está em uso neste workspace",
    "new_project_label": "Tag:",
    "new_project_auto": "auto",
    "new_project_suggesting": "Sugerindo…"
  },
  "search": {
    "placeholder": "Buscar…",
    "results_projects": "Projetos ({{count}})",
    "results_subjects": "Assuntos ({{count}})",
    "results_empty": "Nada encontrado para “{{query}}”",
    "open_identifier": "Abrir {{id}} →",
    "identifier_not_found": "{{id}} não encontrado"
  },
  "archive": {
    "footer_label": "Arquivados ({{count}})",
    "header_back": "← Arquivados",
    "row_reactivate": "Reativar",
    "row_delete_permanent": "Excluir permanentemente",
    "reactivated": "Projeto reativado",
    "reactivate_failed": "Falha ao reativar projeto",
    "archive_action": "Arquivar",
    "archived_toast": "Projeto arquivado",
    "archive_failed": "Falha ao arquivar projeto",
    "editor_banner": "Projeto arquivado — reativar para editar"
  },
```

- [ ] **Step 2: Add the same keys to `en.json` (mirror, both `workspaces` blocks present in en.json)**

```json
  "tags": {
    "edit_title": "Edit tag",
    "edit_current": "Current tag:",
    "edit_new_label": "New tag:",
    "edit_warning": "Warning: external links to {{old}}-N will stop resolving.",
    "edit_save": "Save",
    "edit_cancel": "Cancel",
    "edit_failed": "Failed to update tag",
    "edit_invalid_shape": "Tag must be 2–8 lowercase characters (a-z, 0-9)",
    "edit_reserved": "Reserved tag — pick another",
    "edit_duplicate": "This tag is already in use in this workspace",
    "new_project_label": "Tag:",
    "new_project_auto": "auto",
    "new_project_suggesting": "Suggesting…"
  },
  "search": {
    "placeholder": "Search…",
    "results_projects": "Projects ({{count}})",
    "results_subjects": "Subjects ({{count}})",
    "results_empty": "Nothing found for “{{query}}”",
    "open_identifier": "Open {{id}} →",
    "identifier_not_found": "{{id}} not found"
  },
  "archive": {
    "footer_label": "Archived ({{count}})",
    "header_back": "← Archived",
    "row_reactivate": "Reactivate",
    "row_delete_permanent": "Delete permanently",
    "reactivated": "Project reactivated",
    "reactivate_failed": "Failed to reactivate project",
    "archive_action": "Archive",
    "archived_toast": "Project archived",
    "archive_failed": "Failed to archive project",
    "editor_banner": "Archived project — reactivate to edit"
  },
```

- [ ] **Step 3: Verify JSON parses by importing it**

Run: `node -e "require('./src/i18n/locales/en.json'); require('./src/i18n/locales/pt-BR.json'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en.json src/i18n/locales/pt-BR.json
git commit -m "i18n: add tags/search/archive keys (pt-BR + en)"
```

---

## Phase 1 — Migration: tag, seq, RPCs, backfill

One SQL file. Apply via the Supabase MCP tool (`mcp__plugin_supabase_supabase__apply_migration`) — that's the project's standard path. Backfill runs inline. Verification block fails fast if anything is missed.

### Task 1.1: Write the migration file

**Files:**
- Create: `supabase/migrations/2026-05-17-tags-search-archive.sql`

- [ ] **Step 1: Create the migration file with the full SQL**

```sql
-- supabase/migrations/2026-05-17-tags-search-archive.sql
--
-- Adds Linear-style stable identifiers: projects.tag + subjects.seq render as
-- `flow-3`. Adds projects.next_subject_seq as the monotonic counter the RPC
-- bumps. archived_at columns already exist from 2026-05-14-mcp-expansion.sql
-- and are NOT touched here.
--
-- Order: schema → backfill → constraints → RPCs. Reversing constraints-first
-- deadlocks the backfill on NULL rows.

-- ── 1. Schema additions ────────────────────────────────────────────────────

alter table projects
  add column if not exists tag              text,
  add column if not exists next_subject_seq int  not null default 1;

alter table subjects
  add column if not exists seq int;

-- Shape constraint on tag. Reserved words are blocked at insert time by
-- gen_unique_tag and at client validation; we don't enforce reserved-word
-- rejection in the CHECK because the user may legitimately have edge-case
-- tags pre-existing in their workspace.
alter table projects
  drop constraint if exists projects_tag_shape;
alter table projects
  add constraint projects_tag_shape
    check (tag is null or tag ~ '^[a-z0-9]{2,8}$');

-- ── 2. gen_unique_tag helper ──────────────────────────────────────────────

create or replace function gen_unique_tag(p_name text, p_workspace_id uuid)
returns text
language plpgsql
as $$
declare
  v_base text;
  v_candidate text;
  v_suffix int := 2;
begin
  v_base := lower(regexp_replace(split_part(coalesce(p_name, ''), ' ', 1), '[^a-z0-9]', '', 'gi'));
  if v_base = '' or length(v_base) < 2 then
    v_base := 'proj';
  end if;
  v_base := substring(v_base, 1, 8);

  if v_base in ('new', 'archived', 'settings', 'inbox', 'all') then
    v_base := substring(v_base || 'p', 1, 8);
  end if;

  v_candidate := v_base;
  while exists (select 1 from projects where workspace_id = p_workspace_id and tag = v_candidate) loop
    v_candidate := substring(v_base, 1, 8 - length(v_suffix::text)) || v_suffix::text;
    v_suffix := v_suffix + 1;
    if v_suffix > 999 then
      raise exception 'tag_generation_exhausted for workspace %', p_workspace_id;
    end if;
  end loop;

  return v_candidate;
end $$;

-- ── 3. Backfill ───────────────────────────────────────────────────────────

-- 3a. projects.tag — per workspace to scope collisions
do $$
declare r record;
begin
  for r in
    select id, workspace_id, name
    from projects
    where tag is null
    order by workspace_id, created_at, name
  loop
    update projects
      set tag = gen_unique_tag(r.name, r.workspace_id)
    where id = r.id;
  end loop;
end $$;

-- 3b. subjects.seq — row_number partitioned by (user_id, project_name) since
-- that's the existing logical-key for subjects pre-tag-system.
with ordered as (
  select id,
         row_number() over (
           partition by user_id, project_name
           order by created_at asc, file_name asc
         ) as rn
  from subjects
)
update subjects s
  set seq = ordered.rn
  from ordered
  where s.id = ordered.id;

-- 3c. projects.next_subject_seq = max(seq) + 1 for the project
update projects p
  set next_subject_seq = coalesce(
    (select max(s.seq) + 1 from subjects s
       where s.user_id = p.user_id and s.project_name = p.name),
    1
  );

-- ── 4. Verification ────────────────────────────────────────────────────────

do $$
declare null_tags int; null_seqs int;
begin
  select count(*) into null_tags from projects where tag is null;
  select count(*) into null_seqs from subjects where seq is null;
  if null_tags > 0 then raise exception 'tag backfill missed % rows', null_tags; end if;
  if null_seqs > 0 then raise exception 'seq backfill missed % rows', null_seqs; end if;
end $$;

-- ── 5. NOT NULL + uniqueness ───────────────────────────────────────────────

alter table projects alter column tag set not null;
alter table subjects alter column seq set not null;

create unique index if not exists projects_workspace_tag_uniq
  on projects (workspace_id, tag);

create unique index if not exists subjects_project_seq_uniq
  on subjects (user_id, project_name, seq);

-- ── 6. create_subject RPC ─────────────────────────────────────────────────

create or replace function create_subject(
  p_project_id uuid,
  p_file_name  text,
  p_content    text default ''
)
returns subjects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_ws        uuid;
  v_role      text;
  v_pname     text;
  v_archived  timestamptz;
  v_seq       int;
  v_subject   subjects;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select workspace_id, name, next_subject_seq, archived_at
    into v_ws, v_pname, v_seq, v_archived
  from projects
  where id = p_project_id
  for update;

  if v_ws is null then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;

  v_role := workspace_role(v_ws);
  if v_role not in ('owner', 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_archived is not null then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;

  insert into subjects (user_id, project_name, file_name, content, seq, workspace_id)
  values (v_uid, v_pname, p_file_name, p_content, v_seq, v_ws)
  returning * into v_subject;

  update projects
    set next_subject_seq = v_seq + 1,
        updated_at       = now()
  where id = p_project_id;

  return v_subject;
end $$;

grant execute on function create_subject(uuid, text, text) to authenticated;
grant execute on function gen_unique_tag(text, uuid) to authenticated;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use the MCP tool `mcp__plugin_supabase_supabase__apply_migration` with `name="2026-05-17-tags-search-archive"` and the SQL above as `query`.
Expected: returns success. If it fails, the verification block has fired — inspect the error and fix the backfill query.

- [ ] **Step 3: Verify with a SELECT**

Use `mcp__plugin_supabase_supabase__execute_sql` with:
```sql
select
  (select count(*) from projects where tag is null)         as null_tags,
  (select count(*) from subjects where seq is null)         as null_seqs,
  (select count(*) from pg_proc where proname = 'create_subject') as has_rpc,
  (select count(*) from pg_proc where proname = 'gen_unique_tag') as has_tag_helper;
```
Expected: `null_tags=0`, `null_seqs=0`, `has_rpc=1`, `has_tag_helper=1`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-17-tags-search-archive.sql
git commit -m "feat(db): migration for tags+seq+RPCs (tags-search-archive phase 1)"
```

### Task 1.2: Smoke the create_subject RPC against the live DB

Quick sanity that the RPC produces what we expect before we wire sync to it.

- [ ] **Step 1: Pick a project to test against via SELECT**

Use `mcp__plugin_supabase_supabase__execute_sql`:
```sql
select id, name, tag, next_subject_seq from projects limit 1;
```
Note the `id` and `next_subject_seq` for the next step.

- [ ] **Step 2: Call create_subject as the logged-in DB user — skip if not authenticated**

This RPC requires `auth.uid()`. The Supabase MCP runs as the service role so it bypasses `auth.uid()`. Confirm the RPC raises `not_authenticated`:

```sql
select create_subject(
  (select id from projects limit 1),
  'rpc-smoke-' || floor(extract(epoch from now()))::text,
  ''
);
```
Expected: `ERROR: not_authenticated`. This proves the auth guard fires. Functional testing of the happy path will happen end-to-end via the MCP smoke in Phase 11.

- [ ] **Step 3: No commit — read-only smoke**

---

## Phase 2 — Identifier helper module

A pure TS module so chip color + identifier formatting are testable in isolation.

### Task 2.1: Write the failing tests

**Files:**
- Create: `src/lib/__tests__/identifiers.test.ts`

- [ ] **Step 1: Write tests**

```ts
// src/lib/__tests__/identifiers.test.ts
import { describe, it, expect } from 'vitest';
import {
  subjectIdentifier,
  parseIdentifier,
  tagChipColor,
  isValidTagShape,
  isReservedTag,
} from '@/lib/identifiers';

describe('subjectIdentifier', () => {
  it('returns tag-seq when both present', () => {
    expect(subjectIdentifier({ seq: 3 }, { tag: 'flow' })).toBe('flow-3');
  });
  it('returns empty string when tag missing', () => {
    expect(subjectIdentifier({ seq: 3 }, { tag: null as any })).toBe('');
  });
  it('returns empty string when seq missing', () => {
    expect(subjectIdentifier({ seq: null as any }, { tag: 'flow' })).toBe('');
  });
});

describe('parseIdentifier', () => {
  it('parses flow-3 into parts', () => {
    expect(parseIdentifier('flow-3')).toEqual({ tag: 'flow', seq: 3 });
  });
  it('returns null on bad shape', () => {
    expect(parseIdentifier('flow')).toBeNull();
    expect(parseIdentifier('FLOW-3')).toBeNull();
    expect(parseIdentifier('flow-')).toBeNull();
    expect(parseIdentifier('toolongtag-3')).toBeNull();
  });
});

describe('tagChipColor', () => {
  it('is deterministic for the same input', () => {
    expect(tagChipColor('flow')).toBe(tagChipColor('flow'));
  });
  it('returns one of the palette indices', () => {
    const c = tagChipColor('flow');
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(8);
  });
  it('different tags usually map to different colors', () => {
    const distinct = new Set(['flow', 'auth', 'api', 'docs', 'mkt', 'ops', 'pay', 'lib'].map(tagChipColor));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('isValidTagShape', () => {
  it('accepts valid', () => {
    expect(isValidTagShape('fl')).toBe(true);
    expect(isValidTagShape('flow')).toBe(true);
    expect(isValidTagShape('flow1234')).toBe(true);
  });
  it('rejects invalid', () => {
    expect(isValidTagShape('a')).toBe(false);
    expect(isValidTagShape('toolongtag')).toBe(false);
    expect(isValidTagShape('Flow')).toBe(false);
    expect(isValidTagShape('flo w')).toBe(false);
    expect(isValidTagShape('flow-1')).toBe(false);
  });
});

describe('isReservedTag', () => {
  it('flags reserved words', () => {
    expect(isReservedTag('new')).toBe(true);
    expect(isReservedTag('archived')).toBe(true);
    expect(isReservedTag('settings')).toBe(true);
    expect(isReservedTag('inbox')).toBe(true);
    expect(isReservedTag('all')).toBe(true);
  });
  it('does not flag normal tags', () => {
    expect(isReservedTag('flow')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure (module doesn't exist)**

Run: `npx vitest run src/lib/__tests__/identifiers.test.ts`
Expected: FAIL — `Cannot find module '@/lib/identifiers'`.

### Task 2.2: Implement the identifier module

**Files:**
- Create: `src/lib/identifiers.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/identifiers.ts
//
// Linear-style identifier helpers. The displayed identifier `flow-3` is
// computed at render time from projects.tag + subjects.seq — never persisted
// as a denormalized string. Tag rename is a single UPDATE on the project row.

const RESERVED_TAGS = new Set(['new', 'archived', 'settings', 'inbox', 'all']);
const TAG_SHAPE = /^[a-z0-9]{2,8}$/;
const IDENTIFIER_SHAPE = /^([a-z0-9]{2,8})-(\d+)$/;

// 8 deterministic chip colors. UI consumers map the returned index to a class
// from a Tailwind palette. Keeping the index abstract here lets the palette
// change without touching this module.
const PALETTE_SIZE = 8;

export interface SubjectLike { seq: number | null | undefined }
export interface ProjectLike { tag: string | null | undefined }

export function subjectIdentifier(subject: SubjectLike, project: ProjectLike): string {
  if (!project.tag || !subject.seq) return '';
  return `${project.tag}-${subject.seq}`;
}

export function parseIdentifier(s: string): { tag: string; seq: number } | null {
  const m = IDENTIFIER_SHAPE.exec(s);
  if (!m) return null;
  return { tag: m[1], seq: Number(m[2]) };
}

export function isValidTagShape(s: string): boolean {
  return TAG_SHAPE.test(s);
}

export function isReservedTag(s: string): boolean {
  return RESERVED_TAGS.has(s);
}

// FNV-1a 32-bit hash → palette bucket. Cheap, deterministic, no deps.
export function tagChipColor(tag: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % PALETTE_SIZE;
}
```

- [ ] **Step 2: Run tests — expect pass**

Run: `npx vitest run src/lib/__tests__/identifiers.test.ts`
Expected: PASS — all suites green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/identifiers.ts src/lib/__tests__/identifiers.test.ts
git commit -m "feat: identifier + tag helpers (subjectIdentifier, tagChipColor)"
```

---

## Phase 3 — Sync layer

Wire the new columns into pull/push paths and add RPC wrappers. No UI yet.

### Task 3.1: Add the new columns to the TS row types

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Find the `Project` and `SubjectRecord` types**

Search for `export interface Project` and `export interface SubjectRecord` (or `type Project`) in `src/lib/sync.ts`. They're around the top of the file.

- [ ] **Step 2: Add `tag`, `nextSubjectSeq`, `archivedAt` to Project; `seq`, `archivedAt` to SubjectRecord**

Edit the existing interface declarations. For Project:

```ts
export interface Project {
  name: string;
  path: string;
  workspaceId: string;
  tag: string;
  nextSubjectSeq: number;
  archivedAt: string | null;
}
```

For SubjectRecord (add the two fields preserving existing ones):

```ts
seq: number;
archivedAt: string | null;
```

- [ ] **Step 3: Update `fetchProjects` to select and map the new columns**

At `src/lib/sync.ts:79` (approximately), the existing mapping is:

```ts
return data.map((row: any) => ({ name: row.name, path: row.path, workspaceId: row.workspace_id }));
```

Replace with:

```ts
return data.map((row: any) => ({
  name: row.name,
  path: row.path,
  workspaceId: row.workspace_id,
  tag: row.tag,
  nextSubjectSeq: row.next_subject_seq,
  archivedAt: row.archived_at,
}));
```

- [ ] **Step 4: Update `pushProjects` (lines ~92-101) to write tag + archived_at**

Replace with:

```ts
export async function pushProjects(userId: string, projects: Project[]): Promise<void> {
  await upsertUserRows('projects', userId, projects, (p) => ({
    id: p.name,
    user_id: userId,
    name: p.name,
    path: p.path,
    workspace_id: p.workspaceId,
    tag: p.tag,
    archived_at: p.archivedAt,
    updated_at: new Date().toISOString(),
  }));
}
```

Note: `next_subject_seq` is intentionally absent — clients NEVER write it directly; only `create_subject` RPC bumps it.

- [ ] **Step 5: Update `fetchSubjects` mapping to include `seq` + `archived_at`**

Find `fetchSubjects` (around `src/lib/sync.ts:113`). Add `seq: row.seq, archivedAt: row.archived_at` to the row-mapping object.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): pull/push tag+seq+archived_at columns"
```

### Task 3.2: Add `createSubjectViaRpc` wrapper

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the wrapper near the existing `pushSubject` function (around line 210)**

```ts
export interface CreateSubjectResult {
  ok: boolean;
  subject?: SubjectRecord;
  code?: 'forbidden' | 'project_not_found' | 'project_archived' | 'unknown';
  message?: string;
}

/**
 * Atomic subject creation via the `create_subject` RPC. The RPC owns `seq`
 * emission and bumps `projects.next_subject_seq` in the same transaction —
 * direct INSERT would race on the unique (project, seq) index.
 *
 * Local-first callers should still optimistically insert with a tentative
 * seq (from project.nextSubjectSeq); on success they replace the tentative
 * row with the returned authoritative one. On conflict, re-fetch
 * project.nextSubjectSeq and retry once.
 */
export async function createSubjectViaRpc(
  projectId: string,
  fileName: string,
  content = '',
): Promise<CreateSubjectResult> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase_not_configured' };
  try {
    const { data, error } = await supabase.rpc('create_subject', {
      p_project_id: projectId,
      p_file_name: fileName,
      p_content: content,
    });
    if (error) {
      const msg = error.message || '';
      if (msg.includes('project_archived')) return { ok: false, code: 'project_archived', message: msg };
      if (msg.includes('project_not_found')) return { ok: false, code: 'project_not_found', message: msg };
      if (msg.includes('forbidden') || msg.includes('not_authenticated')) {
        return { ok: false, code: 'forbidden', message: msg };
      }
      return { ok: false, code: 'unknown', message: msg };
    }
    return {
      ok: true,
      subject: {
        id: data.id,
        user_id: data.user_id,
        project_name: data.project_name,
        file_name: data.file_name,
        content: data.content,
        seq: data.seq,
        workspace_id: data.workspace_id,
        archivedAt: data.archived_at,
      } as any,
    };
  } catch (e: any) {
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 2: Add `genUniqueTag` wrapper**

```ts
export async function genUniqueTag(name: string, workspaceId: string): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase.rpc('gen_unique_tag', {
      p_name: name,
      p_workspace_id: workspaceId,
    });
    if (error || typeof data !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Add `updateProjectTag`, `archiveProject`, `unarchiveProject` wrappers**

```ts
export interface UpdateResult { ok: boolean; code?: 'duplicate_tag' | 'invalid_shape' | 'forbidden' | 'unknown'; message?: string }

export async function updateProjectTag(
  projectId: string,
  newTag: string,
): Promise<UpdateResult> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase_not_configured' };
  try {
    const { error } = await supabase
      .from('projects')
      .update({ tag: newTag, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (error) {
      const msg = error.message || '';
      if (msg.includes('projects_workspace_tag_uniq') || msg.includes('duplicate key')) {
        return { ok: false, code: 'duplicate_tag', message: msg };
      }
      if (msg.includes('projects_tag_shape')) {
        return { ok: false, code: 'invalid_shape', message: msg };
      }
      return { ok: false, code: 'unknown', message: msg };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

export async function archiveProject(projectId: string): Promise<UpdateResult> {
  return setProjectArchived(projectId, new Date().toISOString());
}

export async function unarchiveProject(projectId: string): Promise<UpdateResult> {
  return setProjectArchived(projectId, null);
}

async function setProjectArchived(projectId: string, archivedAt: string | null): Promise<UpdateResult> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase_not_configured' };
  try {
    const { error } = await supabase
      .from('projects')
      .update({ archived_at: archivedAt, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (error) return { ok: false, code: 'unknown', message: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add createSubjectViaRpc + tag/archive wrappers"
```

---

## Phase 4 — Planner store

Add slices for search and archive; add mutations that go through the new sync wrappers.

### Task 4.1: Add search + archive slices and selectors

**Files:**
- Modify: `src/stores/planner-store.ts`

- [ ] **Step 1: Add the new state fields to the store interface (around line 118)**

Locate the `allProjects: Project[];` field. Add immediately after:

```ts
  /** Search query (workspace-scoped, applies to active OR archived view). */
  searchQuery: string;
  /** Whether the sidebar is showing the archived list. */
  searchMode: 'active' | 'archived';
```

Also add the action signatures (near other action signatures):

```ts
  setSearchQuery: (q: string) => void;
  setSearchMode: (m: 'active' | 'archived') => void;
  archiveProjectById: (projectId: string) => Promise<void>;
  unarchiveProjectById: (projectId: string) => Promise<void>;
  updateProjectTagById: (projectId: string, newTag: string) => Promise<void>;
```

- [ ] **Step 2: Add initial values**

Where the store's initial state is set (around line 223 where `allProjects: []` is set), add:

```ts
  searchQuery: '',
  searchMode: 'active' as const,
```

- [ ] **Step 3: Implement `setSearchQuery` and `setSearchMode`**

Inside the `create(...)` body, add:

```ts
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchMode: (m) => set({ searchMode: m, searchQuery: '' }),
```

(Switching mode clears the query — the two lists are independent.)

- [ ] **Step 4: Implement mutations using sync wrappers**

Import the new wrappers at top of file:

```ts
import {
  // ...existing imports...
  archiveProject as remoteArchiveProject,
  unarchiveProject as remoteUnarchiveProject,
  updateProjectTag as remoteUpdateProjectTag,
} from '@/lib/sync';
```

Then add the actions (alongside the existing `deleteProject`, after line ~338):

```ts
  archiveProjectById: async (projectId) => {
    const result = await remoteArchiveProject(projectId);
    if (!result.ok) throw new Error(result.message ?? result.code ?? 'archive_failed');
    const stamp = new Date().toISOString();
    const newAll = get().allProjects.map((p: any) =>
      p.id === projectId ? { ...p, archivedAt: stamp } : p,
    );
    set({ allProjects: newAll, projects: recomputeProjects(newAll) });
  },
  unarchiveProjectById: async (projectId) => {
    const result = await remoteUnarchiveProject(projectId);
    if (!result.ok) throw new Error(result.message ?? result.code ?? 'unarchive_failed');
    const newAll = get().allProjects.map((p: any) =>
      p.id === projectId ? { ...p, archivedAt: null } : p,
    );
    set({ allProjects: newAll, projects: recomputeProjects(newAll) });
  },
  updateProjectTagById: async (projectId, newTag) => {
    const result = await remoteUpdateProjectTag(projectId, newTag);
    if (!result.ok) throw new Error(result.code ?? 'tag_update_failed');
    const newAll = get().allProjects.map((p: any) =>
      p.id === projectId ? { ...p, tag: newTag } : p,
    );
    set({ allProjects: newAll, projects: recomputeProjects(newAll) });
  },
```

Note: This assumes `Project` carries an `id`. If the existing `Project` type uses `name` as the PK (per `pushProjects` on line ~94 using `id: p.name`), then `projectId` here is the project name. The wrappers accept the same value — Supabase's projects PK is `name`-shaped per existing code. Verify by checking how `pushProjects` and existing mutations resolve a project to its DB row.

If `name`-as-id holds, also update `setProjectArchived`/`updateProjectTag` in sync.ts to use `.eq('name', projectId).eq('user_id', userId)` instead of `.eq('id', projectId)`. The wrappers already work either way as long as the column matches the schema.

- [ ] **Step 5: Update `recomputeProjects` to filter archived projects out of the active view**

Find `recomputeProjects` (around line 104). Replace with:

```ts
function recomputeProjects(allProjects: Project[]): Project[] {
  const currentWsId = useWorkspacesStore.getState().currentWorkspaceId;
  const wsFiltered = currentWsId
    ? allProjects.filter((p) => p.workspaceId === currentWsId)
    : allProjects;
  return wsFiltered.filter((p: any) => !p.archivedAt);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/stores/planner-store.ts
git commit -m "feat(store): search + archive slices, archive/tag mutations"
```

### Task 4.2: Add the visibility selectors

**Files:**
- Modify: `src/stores/planner-store.ts`

Selectors are pure functions over state — kept outside the Zustand store so React components subscribe via `useStore(selector)` and re-render minimally.

- [ ] **Step 1: Export selectors at the bottom of the file**

```ts
import { parseIdentifier, subjectIdentifier } from '@/lib/identifiers';

export function selectVisibleProjects(state: PlannerState) {
  const list = state.searchMode === 'archived'
    ? state.allProjects.filter((p: any) => p.archivedAt)
    : state.allProjects.filter((p: any) => !p.archivedAt);
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p: any) =>
    p.name.toLowerCase().includes(q) || (p.tag && p.tag.toLowerCase().startsWith(q)),
  );
}

export function selectArchivedCount(state: PlannerState) {
  return state.allProjects.filter((p: any) => p.archivedAt).length;
}

export interface SubjectHit { subject: any; project: any }

export function selectSubjectSearchHits(state: PlannerState): SubjectHit[] {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q || state.searchMode === 'archived') return [];
  const activeProjects = state.allProjects.filter((p: any) => !p.archivedAt);
  const projectByName = new Map(activeProjects.map((p: any) => [p.name, p]));
  // Subjects are stored per-project; assume `state.subjectsByProject: Record<projectName, SubjectRecord[]>`
  // exists. If the actual store key is different, swap below.
  const out: SubjectHit[] = [];
  for (const [pname, subs] of Object.entries((state as any).subjectsByProject ?? {})) {
    const project = projectByName.get(pname);
    if (!project) continue;
    for (const s of subs as any[]) {
      if (s.file_name?.toLowerCase().includes(q)) {
        out.push({ subject: s, project });
        if (out.length >= 100) return out;
      }
    }
  }
  return out;
}

export interface IdentifierMatch { subject: any; project: any }

export function selectExactIdentifierMatch(state: PlannerState): IdentifierMatch | null {
  const parsed = parseIdentifier(state.searchQuery.trim().toLowerCase());
  if (!parsed) return null;
  const project = state.allProjects.find((p: any) => p.tag === parsed.tag);
  if (!project) return null;
  const subs = ((state as any).subjectsByProject?.[project.name] ?? []) as any[];
  const subject = subs.find((s) => s.seq === parsed.seq);
  return subject ? { subject, project } : null;
}

void subjectIdentifier; // re-export silence — used by UI consumers
```

If the store does NOT have `subjectsByProject`, find the equivalent (the actual subjects slice name). Search `src/stores/planner-store.ts` for `subjects` to locate the slice.

- [ ] **Step 2: Commit**

```bash
git add src/stores/planner-store.ts
git commit -m "feat(store): selectors for visible projects + search hits + exact-id match"
```

### Task 4.3: Write store tests for the new behavior

**Files:**
- Modify: `src/stores/__tests__/planner-store.test.ts`

- [ ] **Step 1: Add a describe block — first write failing tests**

Append to the existing test file (or create if missing):

```ts
import {
  selectVisibleProjects,
  selectArchivedCount,
  selectSubjectSearchHits,
  selectExactIdentifierMatch,
} from '@/stores/planner-store';

describe('planner-store selectors — tags/search/archive', () => {
  const projects = [
    { id: 'flow', name: 'flow', workspaceId: 'ws', tag: 'flow', nextSubjectSeq: 4, archivedAt: null, path: '/flow' },
    { id: 'old',  name: 'old',  workspaceId: 'ws', tag: 'old',  nextSubjectSeq: 1, archivedAt: '2026-05-01T00:00:00Z', path: '/old' },
  ];
  const subjectsByProject = {
    flow: [
      { id: 's1', file_name: 'login.md',          seq: 1, project_name: 'flow' },
      { id: 's3', file_name: 'reset-password.md', seq: 3, project_name: 'flow' },
    ],
  };
  const base = { allProjects: projects, subjectsByProject, searchQuery: '', searchMode: 'active' } as any;

  it('selectVisibleProjects hides archived in active mode', () => {
    expect(selectVisibleProjects(base).map((p: any) => p.name)).toEqual(['flow']);
  });
  it('selectVisibleProjects shows only archived in archived mode', () => {
    expect(selectVisibleProjects({ ...base, searchMode: 'archived' }).map((p: any) => p.name)).toEqual(['old']);
  });
  it('selectVisibleProjects filters by name substring or tag prefix', () => {
    expect(selectVisibleProjects({ ...base, searchQuery: 'flo' }).map((p: any) => p.name)).toEqual(['flow']);
    expect(selectVisibleProjects({ ...base, searchQuery: 'xx' })).toEqual([]);
  });
  it('selectArchivedCount counts archived rows', () => {
    expect(selectArchivedCount(base)).toBe(1);
  });
  it('selectSubjectSearchHits matches on file_name across active projects', () => {
    const hits = selectSubjectSearchHits({ ...base, searchQuery: 'login' });
    expect(hits).toHaveLength(1);
    expect(hits[0].subject.file_name).toBe('login.md');
  });
  it('selectSubjectSearchHits returns empty in archived mode', () => {
    expect(selectSubjectSearchHits({ ...base, searchQuery: 'login', searchMode: 'archived' })).toEqual([]);
  });
  it('selectExactIdentifierMatch resolves flow-3 → the right subject', () => {
    const m = selectExactIdentifierMatch({ ...base, searchQuery: 'flow-3' });
    expect(m?.subject.seq).toBe(3);
  });
  it('selectExactIdentifierMatch returns null when seq missing', () => {
    expect(selectExactIdentifierMatch({ ...base, searchQuery: 'flow-99' })).toBeNull();
  });
  it('selectExactIdentifierMatch returns null on non-identifier shape', () => {
    expect(selectExactIdentifierMatch({ ...base, searchQuery: 'flow' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect pass (selectors already implemented in Task 4.2)**

Run: `npx vitest run src/stores/__tests__/planner-store.test.ts`
Expected: all new cases PASS. If they fail because the store's actual subject slice key is different, update the test's `subjectsByProject` key AND the selector in Task 4.2.

- [ ] **Step 3: Commit**

```bash
git add src/stores/__tests__/planner-store.test.ts
git commit -m "test(store): cover tag/search/archive selectors"
```

---

## Phase 5 — UI: TagChip + identifier rendering

Smallest UI primitives first.

### Task 5.1: Build TagChip

**Files:**
- Create: `src/components/sidebar/TagChip.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/sidebar/TagChip.tsx
import { tagChipColor } from '@/lib/identifiers';

// 8 chip styles indexed by tagChipColor(tag). Pastel-on-dark / dark-on-light;
// Tailwind handles theme variants. Keeping the palette in this file means a
// designer can re-tune without touching the hash.
const PALETTE: string[] = [
  'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 ring-fuchsia-500/30',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-teal-500/30',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30',
];

export function TagChip({ tag, className = '' }: { tag: string; className?: string }) {
  const klass = PALETTE[tagChipColor(tag)] ?? PALETTE[0];
  return (
    <span
      className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium ring-1 ring-inset ${klass} ${className}`}
      title={tag}
    >
      {tag}
    </span>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/TagChip.tsx
git commit -m "feat(ui): TagChip — deterministic-colored project tag chip"
```

### Task 5.2: Render TagChip + identifier in PlannerTab project/subject rows

**Files:**
- Modify: `src/components/PlannerTab.tsx`

This file is large (1261 lines). Touch only project-row and subject-row JSX.

- [ ] **Step 1: Find the project row JSX**

Search `src/components/PlannerTab.tsx` for the JSX rendering each project in the sidebar list. Look for `.map((p` or `.map((project` returning a row with `p.name`.

- [ ] **Step 2: Inject `<TagChip tag={p.tag} />` before the project name**

Add the import at the top:

```ts
import { TagChip } from '@/components/sidebar/TagChip';
import { subjectIdentifier } from '@/lib/identifiers';
```

Inside the project-row JSX, prepend the chip:

```tsx
<span className="flex items-center gap-2 min-w-0">
  <TagChip tag={p.tag} />
  <span className="truncate">{p.name}</span>
</span>
```

- [ ] **Step 3: Find the subject row JSX and inject the identifier label**

Search for the subject-row JSX (probably `subjects.map(...)` rendering `s.file_name` or similar). Inject:

```tsx
<span className="flex items-center gap-2 min-w-0">
  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
    {subjectIdentifier(s, currentProject)}
  </span>
  <span className="truncate">{s.file_name}</span>
</span>
```

Where `currentProject` is the project object owning the rendered subjects (in scope within the project-expanded section).

- [ ] **Step 4: Visual sanity — start dev server and open the planner**

Run: `npm run dev` (in another terminal — long-running)
Open the app. Confirm:
- Project rows show colored `[flow]` chips left of the name
- Subject rows show `flow-1`, `flow-2`, ... in muted monospace before titles

If chips appear unstyled, Tailwind probably needs the new color classes safelisted — add `safelist` entries in `tailwind.config.*` for the 8 PALETTE classes. (Tailwind by default purges classes not literally referenced; the indexed PALETTE lookup is invisible to the purger.)

- [ ] **Step 5: Commit**

```bash
git add src/components/PlannerTab.tsx tailwind.config.* 2>/dev/null
git commit -m "feat(ui): render TagChip + identifier in sidebar rows"
```

---

## Phase 6 — UI: NewProjectDialog tag field

The "Novo projeto" dialog exists somewhere in `PlannerTab.tsx` or a sibling component. Find first.

### Task 6.1: Locate NewProjectDialog

- [ ] **Step 1: Find the dialog**

Run: `grep -rn "Novo projeto\|new_project\|NewProjectDialog\|create.*Project" src/components/ src/stores/ 2>&1 | head -20`
Note the file and JSX location.

### Task 6.2: Add the tag field

**Files:**
- Modify: located file (likely `src/components/PlannerTab.tsx` or `src/components/NewProjectDialog.tsx`)

- [ ] **Step 1: Add a `tag` state field to the dialog component**

```tsx
const [tag, setTag] = useState('');
const [tagSuggesting, setTagSuggesting] = useState(false);
const [tagError, setTagError] = useState<string | null>(null);
```

- [ ] **Step 2: Add a debounced effect that calls `genUniqueTag` when the name changes**

```tsx
useEffect(() => {
  if (!name.trim() || !currentWorkspaceId) return;
  const handle = setTimeout(async () => {
    setTagSuggesting(true);
    const suggested = await genUniqueTag(name, currentWorkspaceId);
    setTagSuggesting(false);
    if (suggested && !tagManuallyEdited.current) setTag(suggested);
  }, 250);
  return () => clearTimeout(handle);
}, [name, currentWorkspaceId]);

const tagManuallyEdited = useRef(false);
```

- [ ] **Step 3: Add the tag input + validation render**

Below the existing name input:

```tsx
<div className="space-y-1">
  <label className="text-sm">{t('tags.new_project_label')}</label>
  <div className="flex items-center gap-2">
    <input
      value={tag}
      onChange={(e) => {
        tagManuallyEdited.current = true;
        const v = e.target.value;
        setTag(v);
        if (v && !isValidTagShape(v)) setTagError(t('tags.edit_invalid_shape'));
        else if (v && isReservedTag(v)) setTagError(t('tags.edit_reserved'));
        else setTagError(null);
      }}
      placeholder={tagSuggesting ? t('tags.new_project_suggesting') : t('tags.new_project_auto')}
      className="border rounded px-2 py-1 text-sm font-mono w-32"
      maxLength={8}
    />
    {tagError && <span className="text-xs text-destructive">{tagError}</span>}
  </div>
</div>
```

Add imports: `import { genUniqueTag } from '@/lib/sync'; import { isValidTagShape, isReservedTag } from '@/lib/identifiers';`

- [ ] **Step 4: Pass the tag through to the project-creation call**

Find the "Criar" button's onClick handler. Add tag to the payload (the existing `addProject` action signature in planner-store will need a `tag` arg — extend it).

In `src/stores/planner-store.ts`, find `addProject` (around line ~270) and add `tag` parameter, passing through to the sync upsert. The upsert in `pushProjects` already writes `tag` since Phase 3 Task 3.1.

- [ ] **Step 5: Disable Create button when `tagError` non-null or tag empty**

```tsx
<button disabled={!!tagError || !tag || !name.trim()} ...>{t('actions.create')}</button>
```

- [ ] **Step 6: Visual smoke + commit**

Open the dialog in the dev server. Type a project name; tag auto-fills after ~250 ms; manual edit works; invalid shapes show error; reserved words show error.

```bash
git add src/components/PlannerTab.tsx src/stores/planner-store.ts
git commit -m "feat(ui): tag field in NewProjectDialog with auto-suggest"
```

---

## Phase 7 — UI: EditTagDialog

### Task 7.1: Write the dialog component test

**Files:**
- Create: `src/components/dialogs/__tests__/EditTagDialog.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditTagDialog } from '@/components/dialogs/EditTagDialog';

const updateProjectTagById = vi.fn();
vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: { getState: () => ({ updateProjectTagById }) },
}));

describe('EditTagDialog', () => {
  it('rejects invalid shape', () => {
    render(<EditTagDialog open project={{ id: 'flow', name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />);
    const input = screen.getByLabelText(/nova tag|new tag/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bad-Tag' } });
    expect(screen.getByText(/2.{1,3}8|lowercase/i)).toBeInTheDocument();
  });
  it('rejects reserved word', () => {
    render(<EditTagDialog open project={{ id: 'flow', name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />);
    const input = screen.getByLabelText(/nova tag|new tag/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new' } });
    expect(screen.getByText(/reserv/i)).toBeInTheDocument();
  });
  it('saves valid tag', async () => {
    updateProjectTagById.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<EditTagDialog open project={{ id: 'flow', name: 'Flow', tag: 'flow' } as any} onClose={onClose} />);
    const input = screen.getByLabelText(/nova tag|new tag/i);
    fireEvent.change(input, { target: { value: 'growth' } });
    fireEvent.click(screen.getByText(/salvar|save/i));
    await waitFor(() => expect(updateProjectTagById).toHaveBeenCalledWith('flow', 'growth'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run — expect FAIL (component does not exist)**

Run: `npx vitest run src/components/dialogs/__tests__/EditTagDialog.test.tsx`
Expected: FAIL — `Cannot find module '@/components/dialogs/EditTagDialog'`.

### Task 7.2: Implement EditTagDialog

**Files:**
- Create: `src/components/dialogs/EditTagDialog.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/dialogs/EditTagDialog.tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { isValidTagShape, isReservedTag } from '@/lib/identifiers';
import { usePlannerStore } from '@/stores/planner-store';

export interface EditTagDialogProps {
  open: boolean;
  project: { id: string; name: string; tag: string };
  onClose: () => void;
}

export function EditTagDialog({ open, project, onClose }: EditTagDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(project.tag);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  let error: string | null = null;
  if (value && !isValidTagShape(value)) error = t('tags.edit_invalid_shape');
  else if (value && isReservedTag(value)) error = t('tags.edit_reserved');

  const handleSave = async () => {
    if (error || !value || value === project.tag) return;
    setSaving(true);
    try {
      await usePlannerStore.getState().updateProjectTagById(project.id, value);
      onClose();
    } catch (e: any) {
      const code = String(e?.message ?? '');
      if (code === 'duplicate_tag') toast.error(t('tags.edit_duplicate'));
      else toast.error(t('tags.edit_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card rounded-md shadow-lg p-4 w-80 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-medium">{t('tags.edit_title')}</h2>
        <div className="text-xs text-muted-foreground">
          {t('tags.edit_current')} <code>{project.tag}</code>
        </div>
        <div className="space-y-1">
          <label htmlFor="newTag" className="text-xs">{t('tags.edit_new_label')}</label>
          <input
            id="newTag"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={8}
            className="w-full border rounded px-2 py-1 text-sm font-mono"
            autoFocus
          />
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t('tags.edit_warning', { old: project.tag })}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="px-3 py-1 text-sm rounded hover:bg-muted" onClick={onClose}>
            {t('tags.edit_cancel')}
          </button>
          <button
            disabled={!!error || !value || value === project.tag || saving}
            className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
            onClick={handleSave}
          >
            {t('tags.edit_save')}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run tests — expect PASS**

Run: `npx vitest run src/components/dialogs/__tests__/EditTagDialog.test.tsx`
Expected: PASS.

- [ ] **Step 3: Mount the dialog from the project hover menu in PlannerTab**

Find the project-row `⋯` hover menu in `PlannerTab.tsx`. Add an "Editar tag" item between Renomear and Mover:

```tsx
<DropdownMenuItem onClick={() => setEditTagFor(p)}>
  {t('tags.edit_title')}
</DropdownMenuItem>
```

Add `const [editTagFor, setEditTagFor] = useState<typeof p | null>(null);` at the component level.

At the end of the JSX:

```tsx
{editTagFor && (
  <EditTagDialog open project={editTagFor} onClose={() => setEditTagFor(null)} />
)}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/dialogs/EditTagDialog.tsx src/components/dialogs/__tests__/EditTagDialog.test.tsx src/components/PlannerTab.tsx
git commit -m "feat(ui): EditTagDialog + hover-menu entry"
```

---

## Phase 8 — UI: Sidebar search field

### Task 8.1: Build SidebarSearch

**Files:**
- Create: `src/components/sidebar/SidebarSearch.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/sidebar/SidebarSearch.tsx
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import {
  usePlannerStore,
  selectSubjectSearchHits,
  selectExactIdentifierMatch,
} from '@/stores/planner-store';
import { TagChip } from '@/components/sidebar/TagChip';
import { subjectIdentifier, parseIdentifier } from '@/lib/identifiers';

export function SidebarSearch({ onJumpSubject }: { onJumpSubject: (projectName: string, fileName: string) => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const query = usePlannerStore((s) => s.searchQuery);
  const setQuery = usePlannerStore((s) => s.setSearchQuery);
  const subjectHits = usePlannerStore(selectSubjectSearchHits);
  const exactMatch = usePlannerStore(selectExactIdentifierMatch);
  const identifierShape = parseIdentifier(query.trim().toLowerCase());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        setQuery('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setQuery]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          className="w-full pl-7 pr-7 py-1 text-sm border rounded"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && exactMatch) {
              onJumpSubject(exactMatch.project.name, exactMatch.subject.file_name);
              setQuery('');
            }
          }}
        />
        {query && (
          <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
            <X size={12} />
          </button>
        )}
      </div>

      {identifierShape && (
        <button
          disabled={!exactMatch}
          onClick={() => exactMatch && onJumpSubject(exactMatch.project.name, exactMatch.subject.file_name)}
          className="w-full text-left px-2 py-1.5 text-xs rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-default"
        >
          {exactMatch
            ? t('search.open_identifier', { id: subjectIdentifier(exactMatch.subject, exactMatch.project) })
            : t('search.identifier_not_found', { id: query })}
        </button>
      )}

      {query && subjectHits.length > 0 && (
        <div className="space-y-1">
          <div className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('search.results_subjects', { count: subjectHits.length })}
          </div>
          {subjectHits.map((h) => (
            <button
              key={`${h.project.name}/${h.subject.file_name}`}
              onClick={() => { onJumpSubject(h.project.name, h.subject.file_name); setQuery(''); }}
              className="w-full flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted text-left"
            >
              <TagChip tag={h.project.tag} className="shrink-0" />
              <span className="font-mono text-[10px] text-muted-foreground">
                {subjectIdentifier(h.subject, h.project)}
              </span>
              <span className="truncate">{h.subject.file_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire from PlannerTab — mount above the projects list**

In `src/components/PlannerTab.tsx` find the sidebar-root JSX. Add at the top of the projects-list section:

```tsx
<SidebarSearch onJumpSubject={(projectName, fileName) => {
  // existing handler that opens a subject in the editor
  setActiveProject(projectName);
  setActiveSubject(fileName);
}} />
```

Replace `setActiveProject`/`setActiveSubject` with the equivalent functions in PlannerTab (locate by grepping for the existing subject-open handler).

- [ ] **Step 3: Add `selectVisibleProjects` integration — only render projects matching query**

Find the existing `projects.map(...)` in the projects-list JSX. Replace `projects` with the new selector:

```tsx
const visibleProjects = usePlannerStore(selectVisibleProjects);
```

…and map over `visibleProjects` instead.

- [ ] **Step 4: Visual smoke + commit**

Open dev server. Type partial project name → list filters. Type `flow-3` → CTA appears. Press Enter → opens subject. Esc → clears.

```bash
git add src/components/sidebar/SidebarSearch.tsx src/components/PlannerTab.tsx
git commit -m "feat(ui): SidebarSearch with subject hits + exact-identifier CTA"
```

---

## Phase 9 — UI: Archive mode

### Task 9.1: Build ArchivedToggle

**Files:**
- Create: `src/components/sidebar/ArchivedToggle.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/sidebar/ArchivedToggle.tsx
import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';
import { usePlannerStore, selectArchivedCount } from '@/stores/planner-store';

export function ArchivedToggle() {
  const { t } = useTranslation();
  const mode = usePlannerStore((s) => s.searchMode);
  const setMode = usePlannerStore((s) => s.setSearchMode);
  const count = usePlannerStore(selectArchivedCount);

  if (mode === 'archived') {
    return (
      <button
        onClick={() => setMode('active')}
        className="w-full flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
      >
        {t('archive.header_back')}
      </button>
    );
  }
  if (count === 0) return null;
  return (
    <button
      onClick={() => setMode('archived')}
      className="w-full flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
    >
      <Archive size={12} />
      {t('archive.footer_label', { count })}
    </button>
  );
}
```

- [ ] **Step 2: Mount in PlannerTab**

Add `<ArchivedToggle />` at the bottom of the projects-sidebar section (after the "+ Novo projeto" button) when `searchMode === 'active'`, and at the top when `searchMode === 'archived'` (as the back button).

A single `<ArchivedToggle />` mounted at the top of the projects list handles both modes (component switches its render based on mode).

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/ArchivedToggle.tsx src/components/PlannerTab.tsx
git commit -m "feat(ui): ArchivedToggle for sidebar mode switch"
```

### Task 9.2: Add Arquivar / Reativar / Excluir permanentemente menu items

**Files:**
- Modify: `src/components/PlannerTab.tsx`

- [ ] **Step 1: Project hover menu — "Arquivar" entry (active mode)**

In the project-row `⋯` menu, gated on `mode === 'active'`:

```tsx
<DropdownMenuItem onClick={async () => {
  try {
    await usePlannerStore.getState().archiveProjectById(p.id);
    toast.success(t('archive.archived_toast'));
    if (activeProjectName === p.name) setActiveProjectName(null);
  } catch {
    toast.error(t('archive.archive_failed'));
  }
}}>
  {t('archive.archive_action')}
</DropdownMenuItem>
```

- [ ] **Step 2: Archived-mode menu — "Reativar" and "Excluir permanentemente"**

When `searchMode === 'archived'`, replace the hover menu items with:

```tsx
<DropdownMenuItem onClick={async () => {
  try {
    await usePlannerStore.getState().unarchiveProjectById(p.id);
    toast.success(t('archive.reactivated'));
  } catch {
    toast.error(t('archive.reactivate_failed'));
  }
}}>
  {t('archive.row_reactivate')}
</DropdownMenuItem>
<DropdownMenuItem
  className="text-destructive"
  onClick={() => {/* existing deleteProject handler */}}>
  {t('archive.row_delete_permanent')}
</DropdownMenuItem>
```

- [ ] **Step 3: Editor banner for archived projects**

In the editor area (locate by grepping for the editor mount in PlannerTab), add at the top of the editor render:

```tsx
{activeProject?.archivedAt && (
  <div className="px-3 py-2 text-xs bg-amber-500/10 border-b text-amber-700 dark:text-amber-300">
    {t('archive.editor_banner')}
  </div>
)}
```

Also make the editor read-only when `activeProject?.archivedAt` is truthy — either pass `readOnly` to the editor or short-circuit the save handlers with an early return.

- [ ] **Step 4: Visual smoke + commit**

Open dev server. Archive a project → it disappears from active list, count badge "📦 Arquivados (n)" appears. Click → archived list shows the project. Click "Reativar" → it returns to active.

```bash
git add src/components/PlannerTab.tsx
git commit -m "feat(ui): archive/reactivate menu items + read-only editor banner"
```

---

## Phase 10 — MCP integration

Per spec §13.

### Task 10.1: Enrich subject responses with `identifier`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Add a helper at the top of the file**

```rust
// Compute the Linear-style identifier "tag-seq" for a subject row, fetching
// the project's tag inline. Returns Some("flow-3") or None if either piece
// is missing. Used by list_subjects / get_subject / post_subject_revision /
// save_subject response shaping.
fn enrich_with_identifier(subject: &mut serde_json::Value, project_tag: Option<&str>) {
    let seq = subject.get("seq").and_then(|v| v.as_i64());
    if let (Some(tag), Some(seq)) = (project_tag, seq) {
        if let Some(obj) = subject.as_object_mut() {
            obj.insert("identifier".into(), serde_json::Value::String(format!("{tag}-{seq}")));
        }
    }
}
```

- [ ] **Step 2: For each of list_subjects/get_subject/post_subject_revision/save_subject — fetch the project tag(s) and enrich**

Find each tool function in `tools.rs`. They already query `projects` for `workspace_id` or similar — extend the SELECT to include `tag`. Then in the response-shaping phase, call `enrich_with_identifier` on each subject row.

For `list_subjects` (batch) — one extra join:

```rust
// Existing query selects subjects.* ; extend to join projects for tag.
let url = format!(
    "{base}/rest/v1/subjects?select=*,projects!inner(tag)&workspace_id=eq.{ws}",
    base = sb.rest_url(), ws = ws_id
);
```

Then in the row mapping, lift `projects.tag` into the top-level via `enrich_with_identifier(&mut row, row["projects"]["tag"].as_str())`, and strip the nested `projects` object before returning.

For `get_subject` / `post_subject_revision` / `save_subject` (single-row), do the same lookup before returning.

- [ ] **Step 3: Cargo check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): enrich subject responses with identifier (tag-seq)"
```

### Task 10.2: Reroute `save_subject` through `create_subject` RPC

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Find current `save_subject` body**

It does a direct INSERT with `user_id`, `workspace_id`, `project_name`, `file_name` (commit ae7ffb2).

- [ ] **Step 2: Resolve project_name → project_id first**

```rust
let projects_url = format!(
    "{base}/rest/v1/projects?select=id&workspace_id=eq.{ws}&name=eq.{name}&limit=1",
    base = sb.rest_url(),
    ws = ws_id,
    name = urlencoding::encode(&p.project_name),
);
let projects: Vec<Value> = sb.get_json(&projects_url, &token).await?;
let project_id = projects.first()
    .and_then(|p| p.get("id"))
    .and_then(|v| v.as_str())
    .ok_or_else(|| McpError::NotFound(format!("project '{}' not found", p.project_name)))?
    .to_string();
```

- [ ] **Step 3: Call the RPC instead of INSERT**

```rust
let rpc_args = serde_json::json!({
    "p_project_id": project_id,
    "p_file_name": p.file_name,
    "p_content": p.content.clone().unwrap_or_default(),
});
let row = sb.rpc("create_subject", &rpc_args, &token).await?;
// row is the inserted subjects row; enrich with identifier before returning
let mut row_val = row;
// fetch project tag (or grab it from the cached projects lookup above —
// the SELECT can include tag in the same call to avoid a second roundtrip)
enrich_with_identifier(&mut row_val, project_tag.as_deref());
Ok(row_val)
```

Adjust the initial SELECT to also fetch `tag` so we don't roundtrip twice.

- [ ] **Step 4: Map RPC errors back to MCP errors**

```rust
.map_err(|e| match e {
    McpError::SupabaseError(msg) if msg.contains("project_archived") =>
        McpError::InvalidParams("project is archived — restore it first".into()),
    McpError::SupabaseError(msg) if msg.contains("forbidden") =>
        McpError::PermissionDenied("not a member of this workspace, or viewer role".into()),
    other => other,
})
```

- [ ] **Step 5: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): save_subject routes through create_subject RPC for atomic seq"
```

### Task 10.3: Enrich `list_projects` with `tag`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Extend the SELECT in `list_projects` to include `tag` and `archived_at` (if missing)**

The PostgREST `select=` already includes most columns; ensure `tag,archived_at` are listed.

- [ ] **Step 2: No body change needed if select=* is used — verify cargo check passes**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): list_projects exposes tag"
```

---

## Phase 11 — Smoke + verification

### Task 11.1: Extend `smoke-mcp-v2.ps1`

**Files:**
- Modify: `scripts/smoke-mcp-v2.ps1`

- [ ] **Step 1: After the existing subject-creation step, assert the response has `identifier`**

Add after the `save_subject` call result is captured:

```powershell
if (-not $saveSubjectResult.result.identifier) {
  throw "smoke FAILED: save_subject did not return identifier"
}
if ($saveSubjectResult.result.identifier -notmatch '^[a-z0-9]{2,8}-\d+$') {
  throw "smoke FAILED: identifier shape '$($saveSubjectResult.result.identifier)' invalid"
}
Write-Host "✓ save_subject returned identifier $($saveSubjectResult.result.identifier)"
```

- [ ] **Step 2: After list_subjects, assert all rows have `identifier`**

```powershell
$listed = Invoke-McpRpc -Method "list_subjects" -Params @{ project_name = $projectName }
foreach ($s in $listed.result) {
  if (-not $s.identifier) { throw "smoke FAILED: list_subjects row missing identifier" }
}
Write-Host "✓ list_subjects rows carry identifier"
```

- [ ] **Step 3: Assert list_projects rows have `tag`**

```powershell
$listed = Invoke-McpRpc -Method "list_projects" -Params @{}
foreach ($p in $listed.result) {
  if (-not $p.tag) { throw "smoke FAILED: list_projects row missing tag" }
  if ($p.tag -notmatch '^[a-z0-9]{2,8}$') { throw "smoke FAILED: tag '$($p.tag)' invalid shape" }
}
Write-Host "✓ list_projects rows carry tag"
```

- [ ] **Step 4: Run the smoke against a live dev session**

Start the Tauri dev server (`npm run tauri dev` in another terminal), wait for the MCP endpoint to be written to `endpoint.json`, then:

```powershell
$env:MCP_URL = (Get-Content "$env:LOCALAPPDATA\notter-ai\mcp\endpoint.json" | ConvertFrom-Json).url
$env:MCP_ACCOUNT_ID = (Get-ChildItem "$env:LOCALAPPDATA\notter-ai\mcp\*-config.json" | Select -First 1).BaseName -replace '-config$', ''
.\scripts\smoke-mcp-v2.ps1
```

Expected: full lifecycle runs green, identifier assertions log `✓`.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-mcp-v2.ps1
git commit -m "test(smoke): assert identifier + tag fields in MCP responses"
```

### Task 11.2: Manual end-to-end UI smoke

- [ ] **Step 1: Cold-start the app**

Run: `npm run tauri dev`

- [ ] **Step 2: Create a new project**

Click "+ Novo projeto", type "Marketing Flow". Tag auto-fills with `marketin` (or similar, 8-char max). Click Criar. Confirm row appears with chip `[marketin]`.

- [ ] **Step 3: Create three subjects inside it**

Confirm rows show `marketin-1`, `marketin-2`, `marketin-3`.

- [ ] **Step 4: Edit the tag**

Hover project row → ⋯ → Editar tag → change to `mkt`. Confirm chip color changes (different hash) and subject rows now read `mkt-1`, `mkt-2`, `mkt-3` immediately.

- [ ] **Step 5: Search**

Type `mkt-2` in the sidebar search → CTA appears → press Enter → editor opens subject 2.
Type `lo` → if you named one "login", it shows up under Assuntos.
Press Esc → search clears.

- [ ] **Step 6: Archive**

Hover the project → ⋯ → Arquivar. Project disappears, "📦 Arquivados (1)" appears in footer. Click it → see the archived project. Hover → Reativar. Project returns.

- [ ] **Step 7: Cross-account / MCP**

In another terminal, use the smoke script's identifier-extracted bearer to call `update_account_settings { default_workspace_id: <other ws> }`. Confirm the previously-shipped `mcp:workspace-switch` event still fires and switches the workspace. Confirm tags still render correctly after the switch.

- [ ] **Step 8: No commit — manual smoke**

---

## Self-review

After completing all phases, run this checklist:

1. **Spec coverage:**
   - §3 architecture: migration + sync layer + planner store + UI + MCP — all phases mapped. ✓
   - §4 data model: tag CHECK, partial unique index on `(workspace_id, tag)`, `(user_id, project_name, seq)` unique — all in Phase 1 migration. ✓
   - §4.5 create_subject RPC: Phase 1 + Phase 10.2 wiring. ✓
   - §4.6 gen_unique_tag: Phase 1 + Phase 3 (sync wrapper) + Phase 6 (UI consumer). ✓
   - §5 backfill order: schema → backfill → constraints → RPC. ✓ (Phase 1 task 1.1)
   - §6.1 sidebar layout: TagChip + identifier (Phase 5), ArchivedToggle (Phase 9). ✓
   - §6.2 archived mode: Phase 9 covers swap, reactivate, delete-permanent, editor banner. ✓
   - §6.3 search behavior: Phase 8 covers field, results grouping, exact-id CTA. ✓
   - §6.4 new project dialog tag field: Phase 6. ✓
   - §6.5 edit tag dialog: Phase 7. ✓
   - §7 sync layer: Phase 3. ✓
   - §8 planner store slices/selectors: Phase 4. ✓
   - §13 MCP integration: Phase 10. ✓

2. **Placeholder scan:** No TBD/TODO. All code blocks complete.

3. **Type consistency:** `Project.tag` typed string everywhere. `SubjectRecord.seq` typed `number`. `archivedAt` typed `string | null` consistently (Postgres returns ISO string).

4. **Open question:** The `Project` type's PK is `name` in current code (see `pushProjects` → `id: p.name`). The new mutations in Phase 4 take `projectId` arg; in current code that's actually `name`. The plan flags this in Phase 4 Task 4.1 Step 4 and Phase 7 Task 7.2 — the implementer must verify and adjust the column used in `.eq()` calls in sync.ts. Adding this to the first implementation step would catch it before sync writes go out.

---

## Notes for the implementer

- This plan touches many files. Use `superpowers:subagent-driven-development` so each phase runs in its own subagent with review between phases.
- Phase 1 (migration) is irreversible in practice. Once applied, the columns and the partial unique indexes are durable. If you need to back out, write a new migration that drops the additions; do not edit the migration file after it's been applied to a shared DB.
- Phase 10 changes the Rust MCP server. The Tauri dev server auto-rebuilds, but the MCP endpoint URL/port changes on restart — re-read `endpoint.json` after every Rust change before running smokes.
- Visual smokes (Phase 5 step 4, Phase 6 step 6, Phase 7 step 4, Phase 8 step 4, Phase 9 step 4) require the dev server running — `npm run tauri dev`. They are not type-checked away; if you skip them you'll discover Tailwind purge bugs in production builds.
