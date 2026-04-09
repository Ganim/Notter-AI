// src/components/planning/PlanWithAiButton.tsx
//
// Phase D: "Plan with AI" trigger shown in the Planner note header. Unlike
// the existing green Process button (which runs a v1 LLM flow to decompose
// a note into tasks directly), this button kicks off the v2 autonomous
// planning pipeline (Extract → Security → Data → Prompt-critic) via the
// actions-store.

import { useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useActionsStore } from '@/stores/actions-store';
import type { Action } from '@/types/actions';
import type { Project } from '@/types';

interface PlanWithAiButtonProps {
  project: Project | null;
  subjectName: string | null;
  noteMarkdown: string;
  /** Called after the Action is created so the caller can navigate. */
  onStarted?: (actionId: string) => void;
}

function makeDraftAction(
  project: Project,
  subjectName: string,
  note: string,
): Action {
  const now = new Date();
  const firstLine =
    note
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0) ?? 'Untitled plan';
  return {
    id: `act-${crypto.randomUUID()}`,
    projectName: project.name,
    projectPath: project.path,
    subjectName,
    title: firstLine.slice(0, 120),
    summary: '',
    originalMarkdown: note,
    status: 'draft',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    tasks: [],
  };
}

export function PlanWithAiButton({
  project,
  subjectName,
  noteMarkdown,
  onStarted,
}: PlanWithAiButtonProps) {
  const addAction = useActionsStore((s) => s.addAction);
  const startPlanning = useActionsStore((s) => s.startPlanning);
  const actions = useActionsStore((s) => s.actions);
  const [isStarting, setIsStarting] = useState(false);

  // Find an in-flight planning action for this (project, subject) — we use
  // it purely to disable the button while planning is running.
  const inFlight = useMemo(() => {
    if (!project || !subjectName) return null;
    return (
      actions.find(
        (a) =>
          a.projectName === project.name &&
          a.subjectName === subjectName &&
          a.status === 'planning',
      ) ?? null
    );
  }, [actions, project, subjectName]);

  const disabled =
    !project ||
    !subjectName ||
    !noteMarkdown.trim() ||
    isStarting ||
    inFlight !== null;

  async function handleClick() {
    if (!project || !subjectName || !noteMarkdown.trim()) return;
    setIsStarting(true);
    try {
      const action = makeDraftAction(project, subjectName, noteMarkdown);
      await addAction(action);
      // Fire-and-forget: the pipeline is long-running (minutes); we hand
      // the user off to the Actions tab via onStarted where the stage
      // strip and plan review panel track progress.
      void startPlanning(action.id, { name: project.name, path: project.path });
      toast.success('Planning started — open the Actions tab to watch progress.');
      onStarted?.(action.id);
    } catch (e) {
      toast.error(
        `Failed to start planning: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setIsStarting(false);
    }
  }

  const title = inFlight
    ? 'Planning already in progress for this note'
    : !noteMarkdown.trim()
      ? 'Write a note first'
      : 'Plan with AI (4-stage pipeline)';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {isStarting || inFlight ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <Sparkles size={12} />
      )}
    </button>
  );
}
