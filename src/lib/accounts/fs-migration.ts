import {
  BaseDirectory, exists, mkdir, rename, writeTextFile,
} from '@tauri-apps/plugin-fs';

export const SENTINEL_PATH = 'notter-ai/.migration-v1-complete';

const LEGACY_PATHS = [
  'NotterProjects',
  'AgentProfiles',
  'exec-state',
  'tmp-prompts',
  'actions.json',
];

export interface MigrationResult {
  skipped: boolean;
  moved: string[];
  failed: { path: string; error: string }[];
}

export async function migrateLegacyLayoutIfNeeded(accountId: string): Promise<MigrationResult> {
  const opts = { baseDir: BaseDirectory.AppLocalData };
  if (await exists(SENTINEL_PATH, opts)) {
    return { skipped: true, moved: [], failed: [] };
  }
  await mkdir(`notter-ai/${accountId}`, { ...opts, recursive: true });

  const moved: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const legacy of LEGACY_PATHS) {
    if (!(await exists(legacy, opts))) continue;
    const target = `notter-ai/${accountId}/${legacy}`;
    try {
      await rename(legacy, target, {
        oldPathBaseDir: BaseDirectory.AppLocalData,
        newPathBaseDir: BaseDirectory.AppLocalData,
      });
      moved.push(legacy);
    } catch (e: any) {
      failed.push({ path: legacy, error: e?.message ?? String(e) });
    }
  }

  if (failed.length === 0) {
    await writeTextFile(
      SENTINEL_PATH,
      JSON.stringify({ migratedAt: new Date().toISOString(), accountId, moved }, null, 2),
      opts,
    );
  }

  return { skipped: false, moved, failed };
}
