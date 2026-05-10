// src/components/WorkspaceDeleteDialog.tsx
//
// Phase K — confirmation sub-modal for workspace deletion. Two paths:
//
//   1. "Move all projects to <select>" — calls
//      WorkspaceManager.remove(id, { moveTargetWorkspaceId }), which
//      internally batch-updates each project's workspace_id then deletes
//      the workspace row (FK CASCADE handles nothing — the UPDATE is the
//      move; deleteWorkspace then enforces "no orphan projects" via the
//      has_projects guard).
//
//   2. "Delete projects too" — loops over every project in the target
//      workspace, calls usePlannerStore.deleteProject for each (which
//      cascades to subjects/versions/comments via DB FK), then calls
//      WorkspaceManager.remove(id, { purge: true }) to drop the workspace
//      row itself.
//
// Rendered as a separate Dialog (not a nested AlertDialog) so the existing
// manager dialog stays mounted underneath — closing this sub-modal returns
// the user to the manager view without re-opening it.
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { usePlannerStore } from '@/stores/planner-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';

interface Props {
  open: boolean;
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceDeleteDialog({ open, workspaceId, onOpenChange }: Props) {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const allProjects = usePlannerStore((s) => s.allProjects);

  const target = workspaces.find((w) => w.id === workspaceId);
  const others = workspaces.filter((w) => w.id !== workspaceId);
  const defaultOther = useMemo(
    () => others.find((w) => w.isDefault)?.id ?? others[0]?.id ?? null,
    [others],
  );

  const projectsInTarget = allProjects.filter((p) => p.workspaceId === workspaceId);

  const [mode, setMode] = useState<'move' | 'purge' | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(defaultOther);
  const [busy, setBusy] = useState(false);

  if (!target) return null;

  const handleConfirm = async () => {
    if (!mode || !workspaceId) return;
    setBusy(true);
    try {
      if (mode === 'move') {
        if (!moveTarget) {
          toast.error(t('workspaces.pick_move_target', { defaultValue: 'Pick a target workspace.' }));
          setBusy(false);
          return;
        }
        await getWorkspaceManager().remove(workspaceId, { moveTargetWorkspaceId: moveTarget });
        toast.success(t('workspaces.deleted_moved', {
          defaultValue: 'Workspace deleted; projects moved.',
        }));
      } else {
        // Purge: delete every project under the workspace first, then remove.
        for (const p of projectsInTarget) {
          await usePlannerStore.getState().deleteProject(p.name);
        }
        await getWorkspaceManager().remove(workspaceId, { purge: true });
        toast.success(t('workspaces.deleted_purged', {
          defaultValue: 'Workspace and its projects deleted.',
        }));
      }
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'has_projects') {
        toast.error(t('workspaces.delete_has_projects', {
          defaultValue: 'Some projects could not be moved — workspace not deleted. See logs.',
        }));
      } else {
        toast.error(t('workspaces.delete_failed', { defaultValue: 'Failed to delete workspace.' }));
      }
      console.error('[WorkspaceDeleteDialog] failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('workspaces.delete_title', { defaultValue: 'Delete workspace "{{name}}"?', name: target.name })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('workspaces.delete_desc', {
            defaultValue: 'This workspace has {{count}} project(s). What should happen to them?',
            count: projectsInTarget.length,
          })}
        </p>
        <div className="space-y-2 mt-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'move'}
              onChange={() => setMode('move')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">
                {t('workspaces.delete_move_label', { defaultValue: 'Move all projects to' })}
              </div>
              {mode === 'move' && (
                <select
                  value={moveTarget ?? ''}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="mt-1 text-xs border rounded px-2 py-1 bg-background"
                >
                  {others.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
              )}
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'purge'}
              onChange={() => setMode('purge')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-destructive">
                {t('workspaces.delete_purge_label', { defaultValue: 'Delete projects too' })}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('workspaces.delete_purge_warning', {
                  defaultValue: 'This permanently deletes {{count}} project(s) and every subject, version, and comment under them. This cannot be undone.',
                  count: projectsInTarget.length,
                })}
              </div>
            </div>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={mode === null || busy}
          >
            {busy ? t('workspaces.deleting', { defaultValue: 'Deleting…' }) : t('workspaces.confirm_delete', { defaultValue: 'Delete' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
