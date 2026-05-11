// src/lib/workspaces/workspace-manager.ts
//
// Mirrors src/lib/accounts/account-manager.ts one level deeper. The
// singleton holds the per-account workspaces[] + currentWorkspaceId, and is
// the sole writer for Supabase mutations (add/rename/remove/setDefault).
//
// Bootstrap order (called from auth-store.syncOnLogin AFTER the supabase
// session is established):
//   1. fetchWorkspaces(userId) from Supabase.
//   2. If [] returned, INSERT one default workspace (the migration's
//      backfill only covers users with projects; project-less accounts get
//      a workspace lazily here).
//   3. Read active.json under the account's dir; if present + still valid,
//      restore currentWorkspaceId. Otherwise seed from is_default=true.
//
// Note: workspaces no longer carry MCP bearer tokens. The bearer surface is
// per-account (M3.W2 refactor) — AccountManager owns it. Workspace-aware
// CLIs filter via `list_subjects { workspace_id }` server-side or by reading
// `subjects[*].workspace_id` from the enriched payload.

import {
  readWorkspaceIndex as _readWorkspaceIndex,
  writeWorkspaceIndex,
  readActiveWorkspace,
  writeActiveWorkspace,
} from './workspace-storage';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchWorkspaces, pushWorkspace, renameWorkspace, setWorkspaceDefault,
  deleteWorkspace, moveProjectsBetweenWorkspaces,
} from '@/lib/sync';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { usePlannerStore } from '@/stores/planner-store';

// Silence unused-import warning while keeping the import for future use
// (e.g. offline fast-boot from index.json before fetchWorkspaces resolves).
void _readWorkspaceIndex;

export interface WorkspaceSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

export class WorkspaceManager {
  private workspaces: WorkspaceSummary[] = [];
  private current: string | null = null;
  private booted = false;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch (e) { console.error('[workspace-manager] listener failed', e); }
    }
  }

  /**
   * Refresh useWorkspacesStore from Supabase. Called after every mutation
   * (add / rename / setDefault / remove) so the UI updates immediately
   * instead of waiting for realtime DELETE/INSERT events — Supabase realtime
   * DELETE events on RLS-protected tables can lag or drop entirely, and the
   * UI was missing the deleted workspace's disappearance until next refresh.
   */
  private async syncStoreFromRemote(userId: string): Promise<void> {
    try {
      const rows = await fetchWorkspaces(userId);
      if (rows) {
        useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
      }
      useWorkspacesStore.getState().setCurrentWorkspaceId(this.current);
    } catch (e) {
      console.error('[workspace-manager] syncStoreFromRemote failed:', e);
    }
  }

  get currentWorkspaceId(): string | null { return this.current; }
  list(): WorkspaceSummary[] { return [...this.workspaces]; }
  get(id: string): WorkspaceSummary | null { return this.workspaces.find((w) => w.id === id) ?? null; }

  /** Reset hook called from registerResettableStore on account-switch. */
  reset(): void {
    this.workspaces = [];
    this.current = null;
    this.booted = false;
    this.notify();
  }

  async bootstrap(): Promise<void> {
    if (this.booted) return;
    const accountId = getAccountManager().activeAccountId;
    const userId = useAuthStore.getState().user?.id;
    if (!accountId || !userId) {
      // Benign race during signInWithEmail: supabase.auth.signInWithPassword
      // dispatches SIGNED_IN before setActiveAccountId() runs, so the first
      // bootstrap attempt sees a null accountId. The subsequent setSession
      // re-fires SIGNED_IN with active set and bootstrap succeeds. Demoted
      // from warn to debug to avoid log noise on every signin.
      console.debug('[workspace-manager] bootstrap deferred — auth state not yet settled');
      return;
    }

    // 1. Fetch from Supabase.
    let remote = (await fetchWorkspaces(userId)) ?? [];

    // 2. Lazy default for project-less accounts.
    if (remote.length === 0) {
      const id = crypto.randomUUID();
      const result = await pushWorkspace({
        id, userId, name: "User's workspace", isDefault: true,
      });
      if (result.ok) {
        remote = [{
          id, userId, name: "User's workspace", isDefault: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }];
      } else {
        // Re-fetch — a parallel sign-in on another device may have created one.
        remote = (await fetchWorkspaces(userId)) ?? [];
      }
    }

    this.workspaces = remote.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault }));

    // 3. Persist index.json for offline fast-boot.
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });

    // 4. Restore active pointer.
    const active = await readActiveWorkspace(accountId);
    if (active.workspaceId && this.workspaces.some((w) => w.id === active.workspaceId)) {
      this.current = active.workspaceId;
    } else {
      this.current = this.workspaces.find((w) => w.isDefault)?.id ?? this.workspaces[0]?.id ?? null;
      if (this.current) await writeActiveWorkspace(accountId, { workspaceId: this.current });
    }

    this.booted = true;
    this.notify();
  }

  async switchWorkspace(targetId: string): Promise<void> {
    if (!this.workspaces.some((w) => w.id === targetId)) {
      throw new Error(`unknown workspace ${targetId}`);
    }
    if (this.current === targetId) return;
    const accountId = getAccountManager().activeAccountId;
    if (!accountId) throw new Error('switchWorkspace: no active account');
    this.current = targetId;
    await writeActiveWorkspace(accountId, { workspaceId: targetId });
    this.notify();
  }

  async add(input: { name: string; isDefault?: boolean }): Promise<WorkspaceSummary> {
    const accountId = getAccountManager().activeAccountId;
    const userId = useAuthStore.getState().user?.id;
    if (!accountId || !userId) throw new Error('add: not signed in');
    if (this.workspaces.some((w) => w.name === input.name)) {
      throw new Error('duplicate_name');
    }
    const id = crypto.randomUUID();
    const isDefault = input.isDefault ?? false;
    const result = await pushWorkspace({ id, userId, name: input.name, isDefault });
    if (!result.ok) throw new Error(result.code);

    if (isDefault) {
      // Clear is_default on the previous default in-memory; setWorkspaceDefault
      // already did the DB writes inside pushWorkspace's transaction window
      // via the partial unique index — but if it fired in REST order, the
      // first INSERT may have collided. Be safe: call setWorkspaceDefault
      // explicitly to converge.
      await setWorkspaceDefault(id, userId);
      this.workspaces = this.workspaces.map((w) => ({ ...w, isDefault: false }));
    }

    const summary: WorkspaceSummary = { id, name: input.name, isDefault };
    this.workspaces.push(summary);
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });

    this.notify();
    await this.syncStoreFromRemote(userId);
    return summary;
  }

  async rename(id: string, newName: string): Promise<void> {
    const userId = useAuthStore.getState().user?.id;
    const accountId = getAccountManager().activeAccountId;
    if (!userId || !accountId) throw new Error('rename: not signed in');
    if (this.workspaces.some((w) => w.id !== id && w.name === newName)) {
      throw new Error('duplicate_name');
    }
    const result = await renameWorkspace(id, userId, newName);
    if (!result.ok) throw new Error(result.code);
    this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, name: newName } : w));
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });
    this.notify();
    await this.syncStoreFromRemote(userId);
  }

  async setDefault(id: string): Promise<void> {
    const userId = useAuthStore.getState().user?.id;
    const accountId = getAccountManager().activeAccountId;
    if (!userId || !accountId) throw new Error('setDefault: not signed in');
    await setWorkspaceDefault(id, userId);
    this.workspaces = this.workspaces.map((w) => ({ ...w, isDefault: w.id === id }));
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });
    this.notify();
    await this.syncStoreFromRemote(userId);
  }

  async remove(
    id: string,
    opts: { moveTargetWorkspaceId: string } | { purge: true },
  ): Promise<void> {
    const userId = useAuthStore.getState().user?.id;
    const accountId = getAccountManager().activeAccountId;
    if (!userId || !accountId) throw new Error('remove: not signed in');
    if (this.workspaces.length <= 1) {
      throw new Error('cannot_remove_last_workspace');
    }
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`unknown workspace ${id}`);
    if (ws.isDefault && 'moveTargetWorkspaceId' in opts) {
      throw new Error('cannot_remove_default_workspace');
    }

    if ('moveTargetWorkspaceId' in opts) {
      const moved = await moveProjectsBetweenWorkspaces(userId, id, opts.moveTargetWorkspaceId);
      if (!moved.ok) throw new Error(moved.message);

      // Optimistically reflect the bulk UPDATE in usePlannerStore.allProjects.
      // The Supabase realtime UPDATE event would eventually do this via
      // refetchProjects, but RLS-protected UPDATEs can be slow or lossy —
      // refresh locally so the destination workspace shows the moved
      // projects without a page reload. Re-using applyRemoteProjects
      // triggers the recomputeProjects derivation under the hood.
      const targetId = opts.moveTargetWorkspaceId;
      const remapped = usePlannerStore.getState().allProjects.map((p) =>
        p.workspaceId === id ? { ...p, workspaceId: targetId } : p,
      );
      usePlannerStore.getState().applyRemoteProjects(remapped);
    } else {
      // purge path — projects need to go too. Caller (delete-dialog) issues
      // the project deletes via usePlannerStore.deleteProject for each project
      // in the workspace BEFORE calling remove(). This method does not own
      // the project teardown; it only handles workspace-row removal.
    }

    const delResult = await deleteWorkspace(id, userId);
    if (!delResult.ok) {
      // 'has_projects' means UPDATE didn't cover every row OR purge wasn't
      // performed by the caller. Surface to UI.
      throw new Error(delResult.code);
    }

    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });
    if (this.current === id) {
      this.current = this.workspaces.find((w) => w.isDefault)?.id ?? this.workspaces[0]?.id ?? null;
      if (this.current) await writeActiveWorkspace(accountId, { workspaceId: this.current });
    }
    this.notify();
    await this.syncStoreFromRemote(userId);
  }
}

let _singleton: WorkspaceManager | null = null;
export function getWorkspaceManager(): WorkspaceManager {
  if (!_singleton) _singleton = new WorkspaceManager();
  return _singleton;
}

export function _resetForTests(): void {
  _singleton = null;
}
