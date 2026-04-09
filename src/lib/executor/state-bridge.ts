// src/lib/executor/state-bridge.ts
//
// Phase E: poll the exec-state file for an Action and fire onChange
// whenever the snapshot differs from the previously observed one. The
// caller (Queue Worker) uses onChange to mirror task status into the
// Zustand store.
//
// Why polling and not inotify/FileSystemWatcher: simpler, portable, and
// the MCP server writes at most a few times per task. 500ms is fast
// enough that the user never notices.

import { readExecState } from './exec-state';
import type { ExecStateFile } from './types';

export interface StartStateBridgeOptions {
  actionId: string;
  intervalMs: number;
  onChange: (state: ExecStateFile) => void | Promise<void>;
}

export interface StateBridgeHandle {
  stop: () => void;
}

function snapshotKey(state: ExecStateFile): string {
  return state.tasks
    .map(
      (t) =>
        `${t.id}:${t.status}:${t.summary ?? ''}:${t.result?.summary ?? ''}`,
    )
    .join('|');
}

export function startStateBridge(
  opts: StartStateBridgeOptions,
): StateBridgeHandle {
  let stopped = false;
  let lastKey = '';

  const tick = async () => {
    if (stopped) return;
    try {
      const s = await readExecState(opts.actionId);
      if (s) {
        const key = snapshotKey(s);
        if (key !== lastKey) {
          lastKey = key;
          await opts.onChange(s);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[state-bridge] poll failed', e);
    }
    if (!stopped) {
      setTimeout(tick, opts.intervalMs);
    }
  };

  setTimeout(tick, 0);

  return {
    stop: () => {
      stopped = true;
    },
  };
}
