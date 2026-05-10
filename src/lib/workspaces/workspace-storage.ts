// src/lib/workspaces/workspace-storage.ts
//
// Per-account workspace index + active-pointer files. Mirrors
// account-storage.ts at the next level down — the storage layer stays pure:
// the manager passes its own accountId in rather than reaching into
// getAccountManager() here.
//
// Layout under AppLocalData:
//   notter-ai/<accountId>/workspaces/index.json   — [{ id, name, isDefault }]
//   notter-ai/<accountId>/workspaces/active.json  — { workspaceId }
import {
  BaseDirectory, readTextFile, writeTextFile, exists, mkdir, rename,
} from '@tauri-apps/plugin-fs';

const ROOT = 'notter-ai';

export interface WorkspaceIndex {
  workspaces: { id: string; name: string; isDefault: boolean }[];
}

export interface ActiveWorkspacePointer {
  workspaceId: string | null;
}

function indexPath(accountId: string): string {
  return `${ROOT}/${accountId}/workspaces/index.json`;
}

function activePath(accountId: string): string {
  return `${ROOT}/${accountId}/workspaces/active.json`;
}

async function ensureDir(accountId: string): Promise<void> {
  const p = `${ROOT}/${accountId}/workspaces`;
  if (!(await exists(p, { baseDir: BaseDirectory.AppLocalData }))) {
    await mkdir(p, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeTextFile(tmp, content, { baseDir: BaseDirectory.AppLocalData });
  try {
    await rename(tmp, path, {
      oldPathBaseDir: BaseDirectory.AppLocalData,
      newPathBaseDir: BaseDirectory.AppLocalData,
    });
  } catch {
    // Windows occasionally refuses cross-handle rename; fall back to direct write.
    await writeTextFile(path, content, { baseDir: BaseDirectory.AppLocalData });
  }
}

export async function readWorkspaceIndex(accountId: string): Promise<WorkspaceIndex> {
  const p = indexPath(accountId);
  if (!(await exists(p, { baseDir: BaseDirectory.AppLocalData }))) {
    return { workspaces: [] };
  }
  try {
    const raw = await readTextFile(p, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.workspaces)) return { workspaces: [] };
    return parsed as WorkspaceIndex;
  } catch (e) {
    console.error('[workspace-storage] read index failed:', e);
    return { workspaces: [] };
  }
}

export async function writeWorkspaceIndex(accountId: string, idx: WorkspaceIndex): Promise<void> {
  await ensureDir(accountId);
  await atomicWrite(indexPath(accountId), JSON.stringify(idx, null, 2));
}

export async function readActiveWorkspace(accountId: string): Promise<ActiveWorkspacePointer> {
  const p = activePath(accountId);
  if (!(await exists(p, { baseDir: BaseDirectory.AppLocalData }))) {
    return { workspaceId: null };
  }
  try {
    const raw = await readTextFile(p, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (typeof parsed?.workspaceId !== 'string' && parsed?.workspaceId !== null) {
      return { workspaceId: null };
    }
    return parsed as ActiveWorkspacePointer;
  } catch (e) {
    console.error('[workspace-storage] read active failed:', e);
    return { workspaceId: null };
  }
}

export async function writeActiveWorkspace(accountId: string, p: ActiveWorkspacePointer): Promise<void> {
  await ensureDir(accountId);
  await atomicWrite(activePath(accountId), JSON.stringify(p, null, 2));
}
