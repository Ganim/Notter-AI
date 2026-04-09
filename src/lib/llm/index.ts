// src/lib/llm/index.ts
//
// Phase C: public entry point for the LLM worker abstraction.
// Re-exports the interface and a factory that returns the right adapter
// for a given worker name.

export type {
  LLMWorker,
  LLMInput,
  LLMResponse,
  LLMWorkerErrorReason,
} from '@/lib/llm/types';

export { LLMWorkerError } from '@/lib/llm/types';

export { ClaudeCodeWorker } from '@/lib/llm/claude-code-worker';
export { GeminiWorker } from '@/lib/llm/gemini-worker';
export { CodexWorker } from '@/lib/llm/codex-worker';

import { LLMWorker } from '@/lib/llm/types';
import { ClaudeCodeWorker } from '@/lib/llm/claude-code-worker';
import { GeminiWorker } from '@/lib/llm/gemini-worker';
import { CodexWorker } from '@/lib/llm/codex-worker';

export type WorkerName = 'claude-code' | 'gemini-cli' | 'codex-cli';

/**
 * Factory: returns a fresh instance of the requested worker. Adapters are
 * stateless so we don't bother caching.
 */
export function getWorker(name: WorkerName): LLMWorker {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeWorker();
    case 'gemini-cli':
      return new GeminiWorker();
    case 'codex-cli':
      return new CodexWorker();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown worker: ${exhaustive}`);
    }
  }
}
