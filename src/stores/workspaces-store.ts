// src/stores/workspaces-store.ts
//
// Zustand-backed view of workspaces for UI components. The canonical writer
// is WorkspaceManager (src/lib/workspaces/workspace-manager.ts) — this store
// just reflects state for React. realtime.ts pushes rows into
// applyRemoteWorkspaces on every postgres_changes event; WorkspaceManager
// pushes the active-id changes via setCurrentWorkspaceId.
//
// ── Circular-import note ───────────────────────────────────────────────────
// This store does NOT import WorkspaceManager. The data flows the other way:
// auth-store.syncOnLogin calls workspaceManager.bootstrap() and then mirrors
// the resulting list/active-id into this store. realtime.ts handles ongoing
// postgres_changes events the same way. Keeping the dependency one-directional
// avoids cycles between manager → mcp → sync → realtime → store → manager.
import { create } from 'zustand';
import type { WorkspaceRecord } from '@/lib/sync';
import { registerResettableStore } from '@/lib/accounts/store-registry';

interface WorkspacesState {
  workspaces: WorkspaceRecord[];
  currentWorkspaceId: string | null;
  loading: boolean;

  setCurrentWorkspaceId: (id: string | null) => void;
  applyRemoteWorkspaces: (rows: WorkspaceRecord[]) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const INITIAL = {
  workspaces: [] as WorkspaceRecord[],
  currentWorkspaceId: null as string | null,
  loading: false,
};

export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  ...INITIAL,
  setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id }),
  applyRemoteWorkspaces: (rows) => set({ workspaces: rows }),
  setLoading: (loading) => set({ loading }),
  reset: () => set(INITIAL),
}));

registerResettableStore(() => useWorkspacesStore.getState().reset());
