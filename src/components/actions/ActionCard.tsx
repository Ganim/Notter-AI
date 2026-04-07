import type { Action } from '@/types/actions';
import { getActionProgress } from '@/stores/actions-store';

interface ActionCardProps {
  action: Action;
  selected: boolean;
  onClick: () => void;
}

export function ActionCard({ action, selected, onClick }: ActionCardProps) {
  const { done, total } = getActionProgress(action);
  const allDone = total > 0 && done === total;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
        selected ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {action.title || '(untitled)'}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {action.projectName}
            {action.subjectName && ` / ${action.subjectName}`}
          </div>
        </div>
        <span
          className={`shrink-0 inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
            allDone
              ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {done}/{total}
        </span>
      </div>
    </button>
  );
}
