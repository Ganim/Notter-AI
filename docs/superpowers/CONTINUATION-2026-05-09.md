# Continuation — 2026-05-09 Session

Use this doc to resume the pivot work in a future session (after restart, context loss, etc.).

## What happened this session

1. **Pathfinder** ran and produced `PATHFINDER-2026-05-09/`:
   - 11 features mapped (`00-features.md`)
   - 11 per-feature flowcharts (`01-flowcharts/`)
   - Within + cross duplication reports
   - Unified proposal with 5 systems + 1 retirement (`03-unified-proposal.md`)
   - 6 handoff prompts ready for `/make-plan` (`04-handoff-prompts.md`)
2. **Pivot brainstorm** explored a major redirect of Notter-AI from "autonomous CLI executor" to "collaborative plan-review IDE with bidirectional MCP."
3. **Vision doc** drafted at `docs/superpowers/specs/2026-05-09-notter-pivot-vision.md` — 6 pillars, 10 open questions.
4. **Phase 1 spec** drafted at `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md`. Scope: pillars 0+1+2+5 (multi-account + plan model + persistent MCP + import/export). Pillars 3 (realtime collab) and 4 (rich rendering) deferred.
5. **Codex review** ran on the draft. Three blockers + four strong concerns identified. All resolved inline. Review log captured in spec §13.

## Status at end of session

- Spec at `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md` is **ready for user approval**.
- User approval gate is the next checkpoint. After approval, the next step is `/superpowers:writing-plans` to produce an implementation plan for M1.
- **Nothing has been committed to git yet.** Suggested commit on resumption (or before): the new spec + the Pathfinder dir + the vision doc + this continuation doc.

## Locked decisions (Phase 1)

| Decision | Choice |
|---|---|
| Phase 1 scope | Pillars 0 + 1 + 2 + 5 (multi-account, plan model, persistent MCP, import/export) |
| Account model | Multi-user fast switcher (separate Supabase users, in-place session swap) |
| MCP transport | HTTP/SSE on `127.0.0.1:<dynamic-port>` + per-account bearer token |
| MCP packaging | In-process Rust (axum) inside Tauri main thread |
| Plan content | Pure markdown + version-scoped comments |
| Versioning | Working draft + explicit snapshots (manual, AI roundtrip, import) |
| Disk format | Markdown + YAML frontmatter |
| Rollout shape | Bottom-up by pillar — 4 milestones M1..M4, each shippable, each gets its own `/make-plan` |
| Token refresh ownership | Front-end is sole Supabase refresh owner; pushes new access tokens to Rust MCP via Tauri command |
| RLS strategy | Denormalize `user_id` onto `plan_versions` and `plan_comments`; trigger-populated; simple ownership policies |
| Legacy MCP coexistence | `notter-mcp-server/` (Node) stays alive in Phase 1 (still spawned by frozen executor). New Rust MCP is independent — different port, different transport, different tables. |

## Milestones (in order)

- **M1 — Multi-account.** AccountManager + secure-store wrapper + custom Supabase storage adapter + AccountSwitcher UI + fs migration with sentinel + per-store `reset()` + namespacing. Includes PATHFINDER System 1 (`SyncedStore` primitive) extraction as a hard prereq for M2.
- **M2 — Plan model + UI.** Supabase schema migration + `PlanStore` + `PlanList`/`PlanEditor`/`SnapshotPanel`/`CommentsPanel` + working draft + snapshots + subjects→plans one-shot migration. Deletes `src/lib/planning/` and unused parts of `src/lib/llm/`.
- **M3 — Persistent MCP server.** Rust `axum` HTTP server in `src-tauri/src/mcp/` + 6 tools + token map + endpoint discovery file with nonce + "Copy MCP config" UI + stable per-account config file.
- **M4 — Import/export.** `gray-matter` integration + frontmatter parser/writer + Import/Export UI buttons.

## How to resume

1. Open `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md` and re-read.
2. If user approves: invoke `/superpowers:writing-plans` with the spec path as input. Target M1 first (bottom-up rollout).
3. If user wants changes: edit the spec, re-run Codex review (the `codex:rescue` agent), revise.
4. **Do NOT** start coding any milestone before its `/make-plan` exists.

## Key file pointers

- Vision: `docs/superpowers/specs/2026-05-09-notter-pivot-vision.md`
- **Phase 1 design (canonical):** `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md`
- Pathfinder analysis: `PATHFINDER-2026-05-09/`
- This continuation: `docs/superpowers/CONTINUATION-2026-05-09.md`

## Open items deferred to `/make-plan`

See spec §12. Brief list: axum vs hyper, OAuth deep-link reuse, Monaco vs textarea, snapshot-button placement, "Codex posted v4" toast UX.

## Things explicitly NOT in Phase 1 (so we don't drift)

- Realtime collab (presence, cursors, concurrent editing).
- Mermaid / image rendering.
- `plan_assets` table.
- `post_comment` and `subscribe_changes` MCP tools.
- Stdio→HTTP MCP bridge binary.
- Migration of legacy `actions` to plans.
- In-app sharing of plans across users.
- JSON / `.notterplan` zip formats.
