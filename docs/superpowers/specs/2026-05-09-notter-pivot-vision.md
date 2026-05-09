# Notter-AI Pivot — Plan Collaboration Vision (pre-spec)

Date: 2026-05-09
Status: Vision under brainstorm. This document is the **input** to `/superpowers:brainstorming` — not a final spec. Contents will be challenged and refined before any spec or `/make-plan` work.

## One-line pivot

Notter-AI pivots from *"autonomous CLI executor running locally"* to *"collaborative plan-review IDE for AI development workflows, with bidirectional MCP for any external CLI/agent."*

## Keep / Kill / Replace (against `PATHFINDER-2026-05-09/00-features.md`)

| # | Feature | Decision | Rationale |
|---|---|---|---|
| 1 | planner | **Keep + evolve heavily** | Becomes central surface. Adds Mermaid, images, versions, comments, presence. |
| 2 | terminal-panes | **Defer (Phase 3)** | Returns when re-introducing auto-injection. Freeze dev. |
| 3 | board-tasks | **Kill or fold (Phase 2)** | Manual kanban; "tasks/subtasks of plan" is different shape. |
| 4 | agent-chat | **Kill or demote** | Replaced by bidirectional MCP. Maybe survives as a "test connection" panel. |
| 5 | ai-providers | **Keep — simpler** | Still need to call AI for reprocessing. Routing role shrinks. |
| 6 | planning-pipeline (4 stages) | **Kill** | External CLI/AI becomes the plan generator. Internal pipeline obsolete. |
| 7 | actions-foundation (v2 model) | **Replace** | Plan document model (versioned, commentable, anchored) supersedes it. |
| 8 | executor (queue-worker) | **Defer (Phase 3)** | Returns with auto-inject. Keep functional, no evolution. |
| 9 | mcp-server-bridge | **Replace — new architecture** | From per-action stdio child to **persistent MCP server**. Reuses state-file patterns; new tool surface. |
| 10 | auth-sync | **Keep + expand** | Multi-account + multi-user + new tables. |
| 11 | auto-updater | **Keep** | Infra. |

## The 6 pillars (Phase 1 of pivot)

### Pillar 0 — Multi-account
- Namespace local fs by `<accountId>` (`NotterProjects/<accountId>/...`, `AgentProfiles/<accountId>/...`, `exec-state/<accountId>/...`, `tmp-prompts/<accountId>/...`).
- localStorage keyed per account (`notter-ai:provider-state:<accountId>`).
- Single Supabase client with active-session swap. Full Zustand store reset + rehydrate on every switch.
- All new tables (`plans`, `plan_versions`, `plan_comments`, `plan_assets`) get `account_id` (or `team_id`) from day 1.
- UI: account switcher with visual cue (avatar/color) so user always knows which context is active.

### Pillar 1 — Plan document model
- New tables: `plans`, `plan_versions` (append-only history), `plan_comments`, `plan_assets`. RLS by team/owner.
- Each plan has a single "current" version pointer; full history immutable.
- Comments anchored to a section/range within a version.

### Pillar 2 — Persistent MCP server
- Long-running, not per-action. Replaces `notter-mcp-server` 1-action stdio child with a single persistent server.
- Initial tools: `get_active_plan`, `post_revised_plan`, `list_comments`, `post_comment`, `subscribe_changes` (probably more — TBD in brainstorm).
- Reuses `notter-mcp-server/src/state.ts` atomic write-tmp+rename pattern.
- This is the **protocol surface** between Notter and any external CLI/agent.

### Pillar 3 — Realtime collaboration
- Extends `src/lib/realtime.ts` to `plans`, `plan_comments`, and a presence channel (cursors, viewers).
- Conflict resolution model TBD (CRDT? OT? commit-based PR-style?).

### Pillar 4 — Plan rendering
- Mermaid block rendering inside the plan view (`react-markdown` already a dep — add Mermaid plugin).
- Image upload + inline render (Supabase Storage for shared, Tauri fs for local-only).
- No separate "preview" toggle; rendering is always live.

### Pillar 5 — Import / Export
- Canonical format TBD: markdown + frontmatter (transparent) vs `.notterplan` zip (bundles assets) vs JSON (machine-friendly).
- This format is the round-trip protocol with external CLIs and the basis for share/copy flows.

## Open questions for brainstorm

1. **Multi-account scope**: personal vs team — single model, or workspace concept (account ⊃ workspaces ⊃ plans)?
2. **MCP transport**: stdio (per-CLI spawn) vs persistent HTTP/SSE (single server, multi-client)?
3. **Plan format**: markdown+frontmatter or custom? Lossy vs lossless round-trip?
4. **Versioning model**: linear history vs branchable? Diff/merge UX?
5. **Realtime conflict model**: CRDT (live concurrent cursors) vs commit-based (PR-style proposals)?
6. **Comment anchors**: line-range (fragile to edits) vs section-ID (requires structured plan)?
7. **MCP auth across accounts**: how does an external CLI tell the MCP server which account it's acting in?
8. **Phase 1 minimum shippable**: which subset of the 6 pillars ships first? Multi-account + Plan model + Mermaid render is the smallest "useful" cut, but maybe even smaller?
9. **What dies cleanly vs what lingers**: planning-pipeline kill — does anything in `src/lib/planning/` survive (e.g. `extract` stage to seed a plan from raw notes)?
10. **MCP server packaging**: bundled in Notter (Tauri sidecar)? Standalone binary? Hosted?

## Out of scope (Phase 2 / Phase 3)

- Phase 2: tasks/subtasks extracted from a plan (the "make plan factivel" idea).
- Phase 3: auto-inject tasks into terminals (resurrect executor + terminal-panes with new wiring).

## What this document does NOT decide

Anything in "Open questions" above. The brainstorm exists to challenge framing, surface missing constraints, and pick between alternatives before locking the spec.
