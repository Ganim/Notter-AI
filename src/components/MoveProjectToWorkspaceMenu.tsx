// src/components/MoveProjectToWorkspaceMenu.tsx
//
// Per-project kebab menu in the planner sidebar. Click "Move to workspace ▸ <ws>"
// to issue a single FK update via usePlannerStore.moveProjectToWorkspace. The
// derived projects list is filtered by currentWorkspaceId, so the moved row
// disappears from the current sidebar on success.
//
// Phase L (workspaces plan §6.4). Reuses the existing opacity-0/group-hover
// pattern so the kebab fades in alongside the Pen/Trash actions.
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreVertical, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { usePlannerStore } from '@/stores/planner-store';

interface Props {
  projectName: string;
  /** Size override for the kebab icon (default 14, matches PencilLine/Trash2). */
  iconSize?: number;
}

export function MoveProjectToWorkspaceMenu({ projectName, iconSize = 14 }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const others = workspaces.filter((w) => w.id !== currentWorkspaceId);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSubmenuOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleMove = async (targetWsId: string, targetName: string) => {
    setOpen(false);
    setSubmenuOpen(false);
    const prevWsId = currentWorkspaceId;
    try {
      await usePlannerStore.getState().moveProjectToWorkspace(projectName, targetWsId);
      toast.success(
        t('workspaces.moved_toast', {
          defaultValue: 'Moved {{project}} to {{ws}}',
          project: projectName,
          ws: targetName,
        }),
        {
          action: prevWsId
            ? {
                label: t('workspaces.move_undo', { defaultValue: 'Undo' }),
                onClick: () => {
                  void usePlannerStore.getState().moveProjectToWorkspace(projectName, prevWsId);
                },
              }
            : undefined,
        },
      );
    } catch (err) {
      toast.error(t('workspaces.move_failed', { defaultValue: 'Failed to move project.' }));
      console.error('[MoveProjectToWorkspaceMenu] move failed', err);
    }
  };

  // Single-workspace account: nothing to move to. Render nothing so the existing
  // Pen/Trash row stays uncluttered.
  if (others.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); setSubmenuOpen(false); }}
        className="text-muted-foreground hover:text-foreground p-0.5 rounded-sm hover:bg-muted transition-colors"
        title={t('workspaces.move_tooltip', { defaultValue: 'Move project to workspace' })}
      >
        <MoreVertical size={iconSize} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-52 rounded-md border border-border bg-popover text-popover-foreground shadow-md z-50"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setSubmenuOpen(!submenuOpen); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left"
          >
            <FolderInput size={12} />
            <span className="truncate">
              {t('workspaces.move_to', { defaultValue: 'Move to workspace…' })}
            </span>
          </button>
          {submenuOpen && (
            <div className="border-t border-border max-h-64 overflow-auto">
              {others.map((w) => (
                <button
                  key={w.id}
                  onClick={(e) => { e.stopPropagation(); void handleMove(w.id, w.name); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted truncate"
                  title={w.name}
                >
                  {w.name}
                  {w.isDefault ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      · {t('workspaces.default_badge', { defaultValue: 'Default' })}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
