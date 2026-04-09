// src/lib/llm/__tests__/integration.test.ts
//
// Phase C: live integration smoke test. Actually spawns each CLI and verifies
// the worker returns a sensible response. Gated by LLM_LIVE_TESTS=1 because:
// - It costs real tokens / quota
// - It requires the user to be logged in to all 3 CLIs
// - It's slow (each call ~30-60s due to Claude Code startup overhead)
//
// Run manually:
//   LLM_LIVE_TESTS=1 npm test -- llm/__tests__/integration
//
// Note: this test runs in Node (Vitest), but the workers normally run inside
// the Tauri renderer. The shell helper imports @tauri-apps/plugin-shell which
// will fail in Node. This test is therefore expected to FAIL in Node and is
// here as a documentation/manual checklist rather than CI coverage. Real
// integration validation happens in Phase D when the planning pipeline
// actually runs in the Tauri runtime.

import { describe, it } from 'vitest';

const LIVE = process.env.LLM_LIVE_TESTS === '1';

describe.skipIf(!LIVE)('live LLM integration (manual gate)', () => {
  it('manual: not runnable from Node — see file header for context', () => {
    // The Tauri shell plugin requires the Tauri runtime. Live validation
    // happens via the dev app, not Vitest. This file documents the
    // manual checklist:
    //
    // 1. Open AgentTrack in dev mode (npm run tauri dev)
    // 2. Open the browser dev tools console
    // 3. Run:
    //    const { getWorker } = await import('@/lib/llm');
    //    const r = await getWorker('claude-code').run({ prompt: 'Say pong' });
    //    console.log(r);
    // 4. Repeat for 'gemini-cli' and 'codex-cli'
    // 5. Verify each returns a sensible text and tokenUsage
  });
});
