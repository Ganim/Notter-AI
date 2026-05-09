# 02 — Duplication Report (synthesis)

Date: 2026-05-09
Inputs: `02-within-duplication.md` (per-feature scan) + `02-cross-duplication.md` (across-feature scan). Every claim below cites ≥2 `file:line` locations confirmed against source.

This document is the **prioritized intake** for Phase 3 (`03-unified-proposal.md`). For full evidence, read the two source documents.

## Top consolidations (ranked by payoff)

| # | Concern | Type | Lines saved (rough) | Source |
|---|---------|------|---------------------|--------|
| 1 | Actions store `set + schedulePersist` postlude (11+ sites) + `startPlanning`/`retryPlanStage` wholesale duplicate | within | ~330 lines | within #actions-foundation 1, 2 |
| 2 | Sync push pattern (4× DELETE-then-INSERT in `sync.ts`) | cross | ~120 lines + closes a known race | cross #A |
| 3 | Realtime listeners (5× re-SELECT-and-apply in `realtime.ts`) | cross | ~80 lines | cross #B |
| 4 | Per-store debounced persist+push (5 stores, 3 different timeouts, only 1 has flush) | cross | ~50 lines + fixes silent app-close data loss | cross #F |
| 5 | Planning stage glue (`buildUserPrompt` + `expectedIds + runStage + validate` × 3 stages) | within | ~80 lines | within #planning 1, 3 |
| 6 | Planning stage `mergePatchById` loop × 3 | within | ~25 lines | within #planning 2 |
| 7 | CLI worker error classifier (3× `classify*Error` keyword-search) | within + cross | ~50 lines/worker × 3 | within #planning 4 / cross #D sub |
| 8 | LLM JSON cleaning (3× strip-fence-and-brace-slice) | cross | ~40 lines + drift bug class | cross #C |
| 9 | Provider adapter switch in `generateCloud` (5 providers, repeated request/extract scaffolding) | within | ~60 lines | within #ai-providers 1 |
| 10 | MCP server `loadStateOrThrow` / `findTaskOrThrow` (4 tools / 2 tools) | within | ~20 lines | within #mcp-server 1, 2 |
| 11 | Rust PTY `lock + session lookup` boilerplate (3 commands) | within | ~15 lines | within #terminal-panes 1 |
| 12 | `handleSwitchShell` should call `startPty()` instead of inlining it | within | ~10 lines + bug-shape | within #terminal-panes 2 |
| 13 | Boot-time singleton flag race (`bootExecutor`, `startRealtimeSync`, `queue-worker timer`, `auth-store`) | cross | small lines + correctness | cross #G |

## Items we are NOT consolidating

| Concern | Why skipped |
|---|---|
| Codex/Gemini Windows-stdin sentinel | Per-CLI argument shape genuinely incompatible (`'-'` positional vs `' '` after `-p`); abstraction would be larger than duplication. (within #planning 5) |
| Exec-state types duplicated between renderer (`src/lib/executor/types.ts`) and MCP server (`notter-mcp-server/src/state.ts`) | Code already explicitly defers this to "Phase G" with comments at both sites; runtime I/O legitimately differs (Tauri fs vs Node fs). Schema duplication is real but the team has marked this for a separate workstream. (cross #E) |
| MCP tool full read-modify-write envelope | Three call sites with genuinely divergent mutation bodies. Helpers #10 cover the shared parts; wrapping the whole envelope would force divergent return types into a single signature. (within #mcp-server 3) |
| `requeueExecution` v1/v2 status check | Single use site; not duplication. (within #actions-foundation 3) |
| Two LLM transports (HTTP API vs CLI subprocess) | Legitimate at the transport layer. Sub-concerns inside (error classifier, JSON cleaning) are consolidated separately as #7 and #8. (cross #D) |
| v1 PTY runner (`action-runner.ts`) vs v2 queue-worker | This is a **retirement**, not a consolidation. Captured separately in Phase 4 as a deletion task. (cross #E v1/v2 path) |

## Cross-cutting themes

Three large patterns surface across the rankings:

1. **Per-table sync trio** (push + realtime + debounced persist) is copy-pasted 4–5 times across `sync.ts` / `realtime.ts` / each store. → unify as a single "SyncedStore" primitive.
2. **Stage authoring** in `planning-pipeline` was done by copying `security.ts` three times. → unify as a `_shared.ts` with prompt/merge/runStage helpers, plus promote the JSON cleaner and CLI error classifier out of feature-private files.
3. **Actions store** absorbs the most lines because every mutation manually re-runs `set + schedulePersist`, and the planning-launch path was duplicated for retry. → wrap with a small `mutate(updater)` envelope + `runPlanning` helper.

These three themes drive Phase 3.
