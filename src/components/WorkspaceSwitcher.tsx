// src/components/WorkspaceSwitcher.tsx
//
// Header chip + dropdown for switching the active workspace within the
// signed-in account. Mirrors AccountSwitcher.tsx in structure but reads from
// useWorkspacesStore and delegates the canonical write to WorkspaceManager.
//
// The store mirrors WorkspaceManager state via auth-store.syncOnLogin and
// realtime.ts. Mutations should go through the manager so disk + realtime
// stay in sync; setCurrentWorkspaceId on the store is the immediate UI echo
// (the manager's notify path also updates it, but mirroring locally avoids
// a one-frame flicker after the await resolves).
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plus, Settings, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { WorkspaceManagerDialog } from '@/components/WorkspaceManagerDialog';
import { WorkspaceMembersDialog } from '@/components/WorkspaceMembersDialog';

export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const memberCounts = useWorkspacesStore((s) => s.memberCounts);

  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerMode, setManagerMode] = useState<'manage' | 'create'>('manage');
  const [membersOpen, setMembersOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const current = workspaces.find((w) => w.id === currentWorkspaceId);
  if (!current) return null; // pre-bootstrap; render nothing rather than a flicker

  const handleSwitch = async (id: string) => {
    if (id === currentWorkspaceId) {
      setOpen(false);
      return;
    }
    try {
      await getWorkspaceManager().switchWorkspace(id);
      useWorkspacesStore.getState().setCurrentWorkspaceId(id);
      setOpen(false);
    } catch (err: unknown) {
      toast.error(t('workspaces.switch_failed'));
      console.error('[WorkspaceSwitcher] switch failed:', err);
    }
  };

  const openManager = (mode: 'manage' | 'create') => {
    setManagerMode(mode);
    setOpen(false);
    setManagerOpen(true);
  };

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={t('workspaces.switch_tooltip')}
          aria-label={t('workspaces.switcher_label')}
        >
          <span className="max-w-[140px] truncate">{current.name}</span>
          <ChevronDown size={14} />
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 w-56 rounded-md border bg-popover text-popover-foreground shadow-md z-50">
            <div className="py-1">
              {workspaces.length === 1 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('workspaces.only_one')}
                </div>
              )}
              {workspaces.map((ws) => {
                const isCurrent = ws.id === currentWorkspaceId;
                return (
                  <button
                    key={ws.id}
                    onClick={() => handleSwitch(ws.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-muted transition-colors"
                  >
                    <div className="w-4 flex-shrink-0">
                      {isCurrent && <Check size={12} className="text-primary" />}
                    </div>
                    <span
                      className={`flex-1 truncate ${
                        isCurrent ? 'font-medium' : 'text-muted-foreground'
                      }`}
                    >
                      {ws.name}
                    </span>
                    {ws.isDefault && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t('workspaces.default_badge')}
                      </span>
                    )}
                    {(memberCounts[ws.id] ?? 1) > 1 && (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {memberCounts[ws.id]}{' '}
                        {t('workspaces.members_short', { defaultValue: 'membros' })}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="border-t my-1" />
              <button
                onClick={() => {
                  setOpen(false);
                  setMembersOpen(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Users size={12} />
                {t('workspaces.members_entry', { defaultValue: 'Membros e convites' })}
              </button>
              <button
                onClick={() => openManager('create')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Plus size={12} />
                {t('workspaces.add')}
              </button>
              <button
                onClick={() => openManager('manage')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Settings size={12} />
                {t('workspaces.manage')}
              </button>
            </div>
          </div>
        )}
      </div>

      <WorkspaceManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        initialMode={managerMode}
      />
      <WorkspaceMembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
      />
    </>
  );
}
