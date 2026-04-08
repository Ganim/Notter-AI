# Architecture Spike — Results

**Date:** 2026-04-08
**Spec reference:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §15
**Plan reference:** `docs/superpowers/plans/2026-04-08-phase-a-spike.md`

---

## Environment

- OS: Windows 11 Pro 10.0.26100
- Shell: bash (Git Bash on Windows)
- Node: v22.14.0
- Claude Code CLI: 2.1.96
- Gemini CLI: not installed
- Codex CLI: not installed

## MCP registration approach used

The spike used the `--mcp-config` flag pointing at a gitignored `spike/mcp-config.spike.json` file, combined with `--strict-mcp-config` to isolate the invocation from all user-global and project-registered MCP servers. The `claude mcp add` subcommand was deliberately avoided because it mutates the global user config and would have polluted the shared MCP server list for the duration of the spike.

---

## 15.1 — Can Claude Code call an MCP tool?

**Verdict:** PASS

**Evidence:**

CLI invocation (from `spike-runner.ts`):

```
claude --print \
  --mcp-config mcp-config.spike.json \
  --strict-mcp-config \
  --dangerously-skip-permissions
```

Prompt delivered via stdin: `Call the notter-spike echo tool with message="hello-from-spike" and tell me exactly what the tool returned.`

Stdout excerpt:

```
The tool returned: echo: hello-from-spike
```

Exit code: `0`

Windows-specific quirk: Passing the prompt as a positional CLI argument caused shell quoting to eat or mangle the prompt string on Windows/Git Bash. The fix was to pass the prompt via stdin (`child.stdin.write(prompt + '\n'); child.stdin.end()`) with no positional argument, which Claude Code accepts cleanly when `--print` is used.

**Findings:**

- Stdin-based prompt delivery is required on Windows; positional argument quoting is unreliable in Git Bash and must be avoided.
- Subprocess MCP via `--mcp-config <path>` works fully headless — Claude Code spawns `npx tsx src/mcp-server.ts`, connects via stdio MCP protocol, and calls tools without any interactive prompts.
- `--strict-mcp-config` cleanly isolates the test invocation from all user-registered servers (supabase, gmail, context7, claude-mem), preventing interference and reducing startup noise.
- Spawning `claude` without `shell: true` works fine when `claude` is on PATH; no shell wrapper is needed.
- `SPIKE_DIR` must be resolved via `fileURLToPath(import.meta.url)` rather than `new URL().pathname` to get a valid Windows filesystem path from an ES module context.

---

## 15.2 — Can we read token usage from each CLI?

**Verdict:** PARTIAL

**Results table:**

| CLI | Token info? | Location | Format | Parse-ability |
|---|---|---|---|---|
| Gemini | Not installed | n/a | n/a | Install required before Phase C |
| Codex | Not installed | n/a | n/a | Install required before Phase C |
| Claude Code | YES | stdout | JSON | Easy |

**Claude Code parse path:**

Command: `claude --print --output-format json --dangerously-skip-permissions` with prompt on stdin.

Raw stdout sample (from `spike/notes.md`, actual run):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 38004,
  "duration_api_ms": 1272,
  "num_turns": 1,
  "result": "pong",
  "total_cost_usd": 0.11500225,
  "usage": {
    "input_tokens": 5,
    "cache_creation_input_tokens": 16895,
    "cache_read_input_tokens": 18467,
    "output_tokens": 6,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 }
  },
  "modelUsage": {
    "claude-opus-4-6[1m]": {
      "inputTokens": 5,
      "outputTokens": 6,
      "cacheReadInputTokens": 18467,
      "cacheCreationInputTokens": 16895,
      "costUSD": 0.11500225
    }
  }
}
```

Parse: `JSON.parse(stdout).usage`, `JSON.parse(stdout).total_cost_usd`, `JSON.parse(stdout).modelUsage`.

**Findings:**

- Claude Code exposes richer token data than expected: cache hit/miss breakdown (`cache_creation_input_tokens`, `cache_read_input_tokens`), per-model cost breakdown under `modelUsage`, total cost in USD, and API latency separate from wall-clock duration.
- Gemini CLI and Codex CLI require separate install; until then, Gemini/Codex adapters must estimate from input character length.
- The LLMWorker abstraction should include an optional `estimateTokens?` hook for CLIs that do not report usage natively, so adapters that only have char-length estimation still conform to the interface.
- Overall: PARTIAL is ACCEPTABLE for the spike. Token tracking for the primary executor (Claude Code) is guaranteed; planning reviewers can use estimation until the other CLIs are installed in Phase C.

---

## 15.3 — Does MCP tool blocking work?

**Verdict:** PASS

**Evidence:** Wall-elapsed time reported by the runner for a `block({ms: 8000})` call was 55,894ms–56,939ms across runs, well above the 7,500ms threshold. The MCP tool's own measured elapsed was 8,005ms–8,010ms across three runs (all ≥ 8,000ms). Claude Code responded with text matching `"Tool reported elapsed time: 8009ms"` or similar paraphrased forms, confirmed by the regex `/blocked for \d{4,}ms|(elapsed|took|returned|reported)[^.]{0,60}\d{4,}ms/i`.

**Findings:**

- MCP tool calls genuinely block Claude Code's process for the full duration of tool execution — no timeout or "still waiting?" prompts appeared during the 8-second wait.
- HITL mechanism via MCP tool blocking is VIABLE — no need to fall back to filesystem polling or any out-of-band signaling mechanism.
- Claude Code startup + LLM round-trip adds approximately 47–48 seconds per invocation (total wall ~55s minus the 8s block = ~47s overhead); this is the per-Action overhead to budget for in latency estimates.
- Claude paraphrases tool results in its natural-language response rather than quoting them verbatim; the regex used for detection must be flexible enough to match paraphrased forms. This should be documented as a pattern in the LLMWorker adapter.
- The test timeout for test_15_3 was set to 60 seconds (not 30 seconds) to account for the full Claude Code startup latency; 30 seconds would have killed the process before the LLM response was received.

---

## Deviations from the plan

- **Prompt delivery via stdin instead of positional arg** — Discovered that Windows/Git Bash shell quoting eats the positional prompt argument. Fix: pass prompt via `child.stdin.write` and omit the positional arg. This is an improvement, not a regression.
- **`SPIKE_DIR` resolution uses `fileURLToPath` instead of `new URL().pathname`** — On Windows, `new URL().pathname` returns a path with a leading slash (`/D:/...`) which is invalid for Node.js `fs` operations. `fileURLToPath` is the correct approach for ES modules on Windows.
- **`runClaudeCodeOnce` timeout bumped from 30s to 60s for test_15_3** — Claude Code's startup latency plus the 8-second block plus LLM inference comfortably exceeds 30 seconds. 60 seconds is the minimum safe value.
- **Regex in test_15_3 tightened after code review** — The original looser regex could have matched incidental numbers in the response. The tightened version requires either the literal `"blocked for \d{4,}ms"` string or a paraphrase keyword followed by a 4+ digit millisecond value with the `ms` suffix.
- **test_15_3 was added as a separate commit (`c6cb57f`)**, not merged into Task 4's commit — the plan implied a single commit covering both 15.1 and 15.3 scaffolding, but the tests were developed and committed sequentially.
- **Task 6: 2 of 3 CLIs unavailable** — Gemini CLI and Codex CLI are not installed on this machine. Documented as PARTIAL rather than FAIL; this is not a blocker for the spike's core questions.
- **Task 6: no changes made to probe script beyond the plan template** — The token probe ran exactly as designed. No flag adjustments or retries were needed for Claude Code; Gemini and Codex simply failed with spawn errors.

---

## Go / No-Go Decision

**Decision:** GO

**Rationale:**

Tests 15.1 and 15.3 both PASSED, validating the architecture's two core assumptions: Claude Code can be invoked headlessly with a subprocess MCP server via `--mcp-config`, and MCP tool calls block Claude Code's process for the full duration of execution, making them a viable HITL gate without any polling or filesystem-based coordination. Test 15.2 was PARTIAL due to Gemini and Codex CLIs not being installed, but this is not a blocker — per the spec §15, only a 15.1 FAILURE would stop the plan, and the fallback for 15.2 (input character-length estimation) is well-understood and implementable. Claude Code, the primary executor, provides full token and cost data via `--output-format json`. The next step is Phase B (data model + migration v1→v2).

**Next recommended action:** Write the Phase B implementation plan (`docs/superpowers/plans/2026-04-08-phase-b-data-model.md`) and execute it.

**Caveat to document:** Phase C (LLMWorker adapters) must install `gemini` and `codex` CLIs as prerequisites. A task should be added to Phase C's plan specifically: "Verify all 3 CLIs on PATH before writing adapters; if Gemini/Codex are not installed, document install steps and retry the probe before proceeding with those adapters."

---

## Appendix — raw artifacts

- Spike runner source: `spike/src/spike-runner.ts`
- MCP server source: `spike/src/mcp-server.ts`
- Token probe source: `spike/src/token-probe.ts`
- Spike results fixture: `spike/fixtures/spike-results.json` (gitignored, regenerated on each runner invocation)
- Gemini probe output: `spike/fixtures/gemini-output.txt` (gitignored)
- Codex probe output: `spike/fixtures/codex-output.txt` (gitignored)
- Claude Code probe output: `spike/fixtures/claude-code-output.txt` (gitignored)

Commits:
- Scaffold: `c6f9b6a`
- MCP server: `db507d5`
- MCP server args guards: `4f10601`
- Ignore notes.md: `d907463`
- Test 15.1 runner: `ee96dcb`
- Runner hardening (stdin/shell/cwd): `994434f`
- Test 15.3: `4a8917c`
- Test 15.3 regex tightened: `c6cb57f`
- Token probe: `6e14ccf`
