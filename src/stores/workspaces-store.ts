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

type Role = 'owner' | 'editor' | 'viewer';

interface WorkspacesState {
  workspaces: WorkspaceRecord[];
  currentWorkspaceId: string | null;
  /** Caller's role in the current workspace. Null if no current workspace or it's not in `workspaces`. */
  currentRole: Role | null;
  /** Map workspace id → total members. Always 1 in Plan 1. */
  memberCounts: Record<string, number>;
  loading: boolean;

  setCurrentWorkspaceId: (id: string | null) => void;
  applyRemoteWorkspaces: (rows: WorkspaceRecord[]) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const INITIAL = {
  workspaces: [] as WorkspaceRecord[],
  currentWorkspaceId: null as string | null,
  currentRole: null as Role | null,
  memberCounts: {} as Record<string, number>,
  loading: false,
};

function deriveRole(rows: WorkspaceRecord[], currentId: string | null): Role | null {
  if (!currentId) return null;
  const row = rows.find((w) => w.id === currentId);
  return row?.currentRole ?? null;
}

function deriveCounts(rows: WorkspaceRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of rows) out[w.id] = w.memberCount;
  return out;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  ...INITIAL,
  setCurrentWorkspaceId: (id) => {
    const rows = get().workspaces;
    set({ currentWorkspaceId: id, currentRole: deriveRole(rows, id) });
  },
  applyRemoteWorkspaces: (rows) => {
    const currentId = get().currentWorkspaceId;
    set({
      workspaces: rows,
      currentRole: deriveRole(rows, currentId),
      memberCounts: deriveCounts(rows),
    });
  },
  setLoading: (loading) => set({ loading }),
  reset: () => set(INITIAL),
}));

registerResettableStore(() => useWorkspacesStore.getState().reset());
