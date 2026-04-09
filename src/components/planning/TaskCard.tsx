// src/components/planning/TaskCard.tsx
//
// Phase D: one card per task in the Plan Review Panel. Shows the title,
// trust-level badge, the refinedPrompt (collapsible), and securityFlags /
// dataFlags as chips. "Edit refined prompt" is explicitly out of scope
// for the MVP — users who dislike a refined prompt use the reject path.

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ActionTask, TrustLevel } from '@/types/actions';

interface TaskCardProps {
  task: ActionTask;
}

function trustBadgeClass(trust: TrustLevel | undefined): string {
  switch (trust) {
    case 'auto':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/50';
    case 'semi':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/50';
    case 'manual':
      return 'bg-destructive/10 text-destructive border-destructive/50';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

export function TaskCard({ task }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const refined = task.refinedPrompt ?? task.prompt;
  const securityFlags = task.securityFlags ?? [];
  const dataFlags = task.dataFlags ?? [];

  return (
    <div className="rounded-md border border-border bg-background/50">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="flex-1 text-sm font-medium text-foreground truncate">
          {task.objective || task.id}
        </span>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${trustBadgeClass(
            task.trustLevel,
          )}`}
          title={`Trust level: ${task.trustLevel ?? 'unset'}`}
        >
          {task.trustLevel ?? '—'}
        </span>
      </button>

      {/* Flags row — always visible, compact chips */}
      {(securityFlags.length > 0 || dataFlags.length > 0) && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {securityFlags.map((flag, i) => (
            <span
              key={`s-${i}`}
              className="px-1.5 py-0.5 rounded text-[10px] border border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              title="Security flag"
            >
              sec: {flag}
            </span>
          ))}
          {dataFlags.map((flag, i) => (
            <span
              key={`d-${i}`}
              className="px-1.5 py-0.5 rounded text-[10px] border border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400"
              title="Data-consistency flag"
            >
              data: {flag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded refined prompt */}
      {expanded && (
        <div className="px-3 pb-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Refined prompt
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted/40 p-2 rounded border border-border max-h-60 overflow-auto">
            {refined || '(no refined prompt yet)'}
          </pre>
        </div>
      )}
    </div>
  );
}
