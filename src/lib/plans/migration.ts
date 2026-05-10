// src/lib/plans/migration.ts
//
// One-shot, per-account migration: each `subjects` row becomes a `plans` row.
// Title format: "<project_name> / <file_name>" (no .md suffix).
// working_content = subject.content.
// No initial snapshot is created.
//
// Sentinel file: notter-ai/<accountId>/.migration-m2-plans-complete
// Written ONLY after all rows succeed. If any row fails, the sentinel is NOT
// written and the migration can be re-run on next launch.
//
// Idempotent: if the sentinel exists, the function returns { skipped: true }
// immediately — no Supabase queries are made.
//
// Called from `syncOnLogin` in auth-store (NOT App.tsx) — it must run after
// the Supabase session is established or RLS blocks the subjects query.

import { exists, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { tryAccountScopedPath } from '@/lib/accounts/account-paths';

export interface MigrationResult {
  skipped: boolean;
  migrated: number;
  failed: { projectName: string; fileName: string; error: string }[];
}

const SENTINEL_REL = '.migration-m2-plans-complete';

export async function migrateSubjectsToPlans(userId: string): Promise<MigrationResult> {
  if (!isSupabaseConfigured) return { skipped: false, migrated: 0, failed: [] };

  // Use tryAccountScopedPath: returns null if no active account is set
  // (avoids throwing on race conditions during account switch).
  const sentinelPath = tryAccountScopedPath(SENTINEL_REL);
  if (!sentinelPath) {
    console.warn('[migration] no active account; skipping plans migration');
    return { skipped: true, migrated: 0, failed: [] };
  }

  // Check sentinel
  try {
    const done = await exists(sentinelPath, { baseDir: BaseDirectory.AppLocalData });
    if (done) return { skipped: true, migrated: 0, failed: [] };
  } catch {
    // If we can't read the sentinel, treat as not-yet-migrated and proceed.
  }

  // Fetch all subjects for this user
  const { data: subjects, error: fetchError } = await supabase
    .from('subjects')
    .select('project_name, file_name, content, user_id')
    .eq('user_id', userId);

  if (fetchError || !subjects) {
    console.error('[migration] fetchSubjects failed:', fetchError);
    return { skipped: false, migrated: 0, failed: [] };
  }

  if (subjects.length === 0) {
    // Nothing to migrate — write sentinel and return
    await writeSentinel(sentinelPath);
    return { skipped: false, migrated: 0, failed: [] };
  }

  const failed: MigrationResult['failed'] = [];
  let migrated = 0;

  for (const row of subjects) {
    const title = `${row.project_name} / ${row.file_name.replace(/\.md$/i, '')}`;
    const id = crypto.randomUUID();
    try {
      const { error: insertError } = await supabase.from('plans').insert({
        id,
        user_id: userId,
        title,
        working_content: row.content ?? '',
        // current_snapshot_id intentionally null — spec §7 M2: no initial snapshot
      });
      if (insertError) {
        console.error(`[migration] insert failed for ${title}:`, insertError);
        failed.push({ projectName: row.project_name, fileName: row.file_name, error: insertError.message });
      } else {
        migrated++;
      }
    } catch (e: any) {
      console.error(`[migration] insert threw for ${title}:`, e);
      failed.push({ projectName: row.project_name, fileName: row.file_name, error: String(e?.message ?? e) });
    }
  }

  // Write sentinel ONLY if zero failures
  if (failed.length === 0) {
    await writeSentinel(sentinelPath);
  }

  return { skipped: false, migrated, failed };
}

async function writeSentinel(sentinelPath: string): Promise<void> {
  try {
    // Ensure parent dir exists (tryAccountScopedPath returns 'notter-ai/<id>/...' relative to AppLocalData)
    const dir = sentinelPath.substring(0, sentinelPath.lastIndexOf('/'));
    const dirExists = await exists(dir, { baseDir: BaseDirectory.AppLocalData });
    if (!dirExists) {
      await mkdir(dir, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    }
    await writeTextFile(sentinelPath, new Date().toISOString(), { baseDir: BaseDirectory.AppLocalData });
  } catch (e) {
    console.error('[migration] failed to write sentinel:', e);
  }
}
