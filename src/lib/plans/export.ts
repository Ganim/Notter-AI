// src/lib/plans/export.ts
//
// M4 export orchestrator. Picks the version to export (respecting
// previewVersionId), builds the frontmatter from store state, serializes via
// the codec, prompts plugin-dialog.save with a sane default path under the
// account's exports folder, then writes via plugin-fs.writeTextFile.
//
// The "current version" rule: if the user is previewing a historical
// version (subject-versions-store.previewVersionId !== null), we export
// THAT version. Otherwise we export `subject.currentVersionId`. If neither
// exists (subject has zero versions yet), we throw — the UI maps the throw
// to a `export_no_version` toast.

import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { tryAccountScopedPath } from '@/lib/accounts/account-paths';
import { stringifyPlanMarkdown, type ParsedFrontmatter } from '@/lib/plans/frontmatter';
import { slugifyTitle } from '@/lib/plans/slug';
import type { SubjectRecord, SubjectVersionRecord } from '@/lib/sync';

export type ExportResult =
  | { cancelled: false; path: string }
  | { cancelled: true };

export type ExportErrorCode =
  | 'NO_SUBJECT'        // no subject is currently selected
  | 'NO_VERSION'        // selected subject has no current version yet
  | 'VERSION_NOT_LOADED'; // requested version isn't in the loaded slice

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode) {
    super(code);
    this.name = 'ExportError';
    this.code = code;
  }
}

export async function exportCurrentVersion(): Promise<ExportResult> {
  const versionsState = useSubjectVersionsStore.getState();
  const subjectRow = usePlannerStore.getState().selectedSubjectRow();

  if (!subjectRow) {
    throw new ExportError('NO_SUBJECT');
  }

  // Resolve the version: preview > current > error
  const targetVersionId =
    versionsState.previewVersionId ?? subjectRow.currentVersionId ?? null;
  if (!targetVersionId) {
    throw new ExportError('NO_VERSION');
  }
  const target = versionsState.versions.find((v) => v.id === targetVersionId);
  if (!target) {
    throw new ExportError('VERSION_NOT_LOADED');
  }

  return exportVersionInternal(subjectRow, target);
}

export async function exportVersionById(versionId: string): Promise<ExportResult> {
  const versionsState = useSubjectVersionsStore.getState();
  const subjectRow = usePlannerStore.getState().selectedSubjectRow();
  if (!subjectRow) throw new ExportError('NO_SUBJECT');
  const target = versionsState.versions.find((v) => v.id === versionId);
  if (!target) throw new ExportError('VERSION_NOT_LOADED');
  return exportVersionInternal(subjectRow, target);
}

async function exportVersionInternal(
  subjectRow: SubjectRecord,
  target: SubjectVersionRecord,
): Promise<ExportResult> {
  // Build the frontmatter
  const fileNameNoExt = subjectRow.fileName.replace(/\.md$/i, '');
  const title = `${subjectRow.projectName} / ${fileNameNoExt}`;
  const frontmatter: ParsedFrontmatter = {
    subject_id: subjectRow.id,
    version_id: target.id,
    parent_version_id: target.parentVersionId,
    title,
    source: target.source,
    source_actor: target.sourceActor,
    exported_at: new Date().toISOString(),
  };

  const text = stringifyPlanMarkdown({ frontmatter, body: target.contentMarkdown });

  // Default filename: <slug>-<short-id>.md
  const slug = slugifyTitle(title);
  const shortId = target.id.replace(/-/g, '').slice(0, 6);
  const defaultFileName = `${slug}-${shortId}.md`;

  // Default directory: <appLocalData>/notter-ai/<accountId>/exports/.
  // tryAccountScopedPath returns a relative path; for plugin-dialog.save we
  // need an absolute path. The dialog accepts a `defaultPath` that is just
  // a filename — Tauri will open the OS save dialog and let the user pick
  // any directory. We embed a hint by NOT passing a dir; the user picks
  // freely. AFTER the pick, we ensure our own exports dir exists for any
  // future "default to the same dir" logic (out of scope for M4).
  const exportsDirRel = tryAccountScopedPath('exports');
  if (exportsDirRel) {
    try {
      const dirExists = await exists(exportsDirRel, { baseDir: BaseDirectory.AppLocalData });
      if (!dirExists) {
        await mkdir(exportsDirRel, { baseDir: BaseDirectory.AppLocalData, recursive: true });
      }
    } catch (e) {
      console.error('[export] failed to ensure exports dir:', e);
    }
  }

  const path = await save({
    defaultPath: defaultFileName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });

  if (!path) return { cancelled: true };

  // The save dialog returns an absolute path. writeTextFile honors absolute
  // paths when no baseDir is passed.
  await writeTextFile(path, text);
  return { cancelled: false, path };
}
