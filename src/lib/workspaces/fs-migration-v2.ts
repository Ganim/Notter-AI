import {
  BaseDirectory, exists, mkdir, rename, writeTextFile,
} from '@tauri-apps/plugin-fs';

export const SENTINEL_V2_PATH = 'notter-ai/.migration-v2-workspaces-complete';

const WORKSPACE_OWNED_SUBDIRS = ['cache', 'exports'] as const;

export interface MigrationV2Result {
  skipped: boolean;
  moved: string[];
  failed: { path: string; error: string }[];
}

/**
 * Move `<accountId>/cache/` and `<accountId>/exports/` to
 * `<accountId>/<defaultWorkspaceId>/...`. Sentinel-gated. Idempotent:
 * if the target already exists (partial prior run), the source rename is
 * skipped for that subdir.
 */
export async function migrateAccountToWorkspacesIfNeeded(
  accountId: string,
  defaultWorkspaceId: string,
): Promise<MigrationV2Result> {
  const opts = { baseDir: BaseDirectory.AppLocalData };
  if (await exists(SENTINEL_V2_PATH, opts)) {
    return { skipped: true, moved: [], failed: [] };
  }

  await mkdir(`notter-ai/${accountId}/${defaultWorkspaceId}`, {
    ...opts, recursive: true,
  });

  const moved: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const sub of WORKSPACE_OWNED_SUBDIRS) {
    const src = `notter-ai/${accountId}/${sub}`;
    const dst = `notter-ai/${accountId}/${defaultWorkspaceId}/${sub}`;
    if (!(await exists(src, opts))) continue;
    if (await exists(dst, opts)) {
      // Already moved on a partial prior run — skip without error.
      moved.push(sub);
      continue;
    }
    try {
      await rename(src, dst, {
        oldPathBaseDir: BaseDirectory.AppLocalData,
        newPathBaseDir: BaseDirectory.AppLocalData,
      });
      moved.push(sub);
    } catch (e: any) {
      failed.push({ path: sub, error: e?.message ?? String(e) });
    }
  }

  if (failed.length === 0) {
    await writeTextFile(
      SENTINEL_V2_PATH,
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        perAccount: [{ accountId, workspaceId: defaultWorkspaceId, moved }],
      }, null, 2),
      opts,
    );
  }

  return { skipped: false, moved, failed };
}
