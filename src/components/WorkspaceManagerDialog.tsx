// src/components/WorkspaceManagerDialog.tsx
//
// Two-section workspace management dialog.
//
// Section 1: list of workspaces with inline rename (click name to edit, Enter
// to commit, Esc to cancel), "Set as default" inline link on non-default
// rows, and delete button. Delete is disabled when (a) only one workspace
// exists, or (b) the row is default with siblings — the user must demote
// first via "Set as default" on another row.
//
// Section 2: create form (name input + "Set as default" toggle + Create
// button). Validates non-empty and not-duplicate; surfaces inline error toast
// on failure.
//
// MCP config copy is no longer per-workspace — the bearer is per-account.
// Use UserMenu → "MCP config" for the active account's config.
//
// Delete is delegated to WorkspaceDeleteDialog (move-or-purge sub-modal).
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Trash2, Plus, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { WorkspaceDeleteDialog } from '@/components/WorkspaceDeleteDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: 'manage' | 'create';
}

export function WorkspaceManagerDialog({ open, onOpenChange, initialMode = 'manage' }: Props) {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    if (open && initialMode === 'create') {
      // Focus-defer; rely on autoFocus on the input below.
    }
  }, [open, initialMode]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await getWorkspaceManager().add({ name: newName.trim(), isDefault: newIsDefault });
      // Trigger a realtime-equivalent refresh of the store. The realtime
      // sub will catch up shortly, but seed immediately for snappiness:
      const list = getWorkspaceManager().list();
      useWorkspacesStore.getState().applyRemoteWorkspaces(list.map((w) => ({
        id: w.id, userId: '', name: w.name, isDefault: w.isDefault,
        createdAt: '', updatedAt: '',
        currentRole: 'owner', memberCount: 1,
      })));
      setNewName('');
      setNewIsDefault(false);
      toast.success(t('workspaces.created'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'duplicate_name') {
        toast.error(t('workspaces.duplicate_name'));
      } else {
        toast.error(t('workspaces.create_failed'));
        console.error(err);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!renameDraft.trim()) { setRenamingId(null); return; }
    setBusyId(id);
    try {
      await getWorkspaceManager().rename(id, renameDraft.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'duplicate_name') {
        toast.error(t('workspaces.duplicate_name'));
      } else {
        toast.error(t('workspaces.rename_failed'));
      }
    } finally {
      setBusyId(null);
      setRenamingId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    setBusyId(id);
    try {
      await getWorkspaceManager().setDefault(id);
    } catch {
      toast.error(t('workspaces.set_default_failed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('workspaces.manage_title')}</DialogTitle>
          </DialogHeader>

          {/* Section 1: list */}
          <div className="space-y-1 mt-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              {t('workspaces.current_section')}
            </p>
            {workspaces.map((ws) => {
              const isOnlyOne = workspaces.length === 1;
              const canDelete = !isOnlyOne && !ws.isDefault;
              const isRenaming = renamingId === ws.id;
              return (
                <div key={ws.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted">
                  {isRenaming ? (
                    <Input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => handleRename(ws.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(ws.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="h-7 text-sm flex-1"
                    />
                  ) : (
                    <span
                      className="flex-1 text-sm cursor-text"
                      onClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
                    >
                      {ws.name}
                    </span>
                  )}
                  {ws.isDefault && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      {t('workspaces.default_badge')}
                    </span>
                  )}
                  {!ws.isDefault && (
                    <button
                      onClick={() => handleSetDefault(ws.id)}
                      disabled={busyId === ws.id}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {busyId === ws.id ? <Loader2 size={12} className="animate-spin" /> : t('workspaces.set_default')}
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteTarget(ws.id)}
                    disabled={!canDelete}
                    className="p-1 rounded hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                    title={!canDelete ? t('workspaces.cannot_delete_default') : t('workspaces.delete')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Section 2: create */}
          <div className="border-t pt-3 mt-3 space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('workspaces.create_section')}
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('workspaces.create_placeholder')}
                className="h-8 text-sm flex-1"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                autoFocus={initialMode === 'create'}
              />
              <Label className="flex items-center gap-1 text-xs">
                <Switch checked={newIsDefault} onCheckedChange={setNewIsDefault} />
                {t('workspaces.set_default')}
              </Label>
              <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
                {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <WorkspaceDeleteDialog
        open={deleteTarget !== null}
        workspaceId={deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
      />
    </>
  );
}
