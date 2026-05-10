// src/lib/plans/import.ts
//
// M4 import orchestrator. Side-effecty by design — coordinates the codec
// (frontmatter.ts) with the two relevant stores (planner-store, subject-
// versions-store) and the Tauri fs plugin.
//
// Two entry points:
//   - importMarkdownFile(absolutePath)  — used by the UI button after the
//     user picks a file via plugin-dialog.open().
//   - importMarkdownText(text, sourceFilename) — testable, takes text directly.
//     The UI doesn't call this, but tests do.
//
// Decision tree: see plan §"Phase D — import.ts orchestrator" for the
// canonical spec.

import { readTextFile } from '@tauri-apps/plugin-fs';
import { parsePlanMarkdown } from '@/lib/plans/frontmatter';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';

const FALLBACK_PROJECT_NAME = 'Importados';

export type ImportResult =
  | { kind: 'version_added'; subjectId: string; versionId: string }
  | { kind: 'subject_created'; subjectId: string; versionId: string };

export type ImportErrorCode =
  | 'NO_VERSION_AFTER_TIMEOUT';  // subject created but realtime row didn't arrive within 5s

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly subjectId: string | null;
  readonly projectName: string;
  readonly fileName: string;
  constructor(
    code: ImportErrorCode,
    projectName: string,
    fileName: string,
    subjectId: string | null = null,
  ) {
    super(`${code}: ${projectName}/${fileName}`);
    this.name = 'ImportError';
    this.code = code;
    this.subjectId = subjectId;
    this.projectName = projectName;
    this.fileName = fileName;
  }
}

export async function importMarkdownFile(absolutePath: string): Promise<ImportResult> {
  // The Tauri dialog returns an absolute path; readTextFile honors absolute
  // paths when no baseDir is passed.
  const text = await readTextFile(absolutePath);
  // Extract just the filename (last segment) for the snapshot label
  const seg = absolutePath.split(/[\\/]/).pop() ?? 'imported.md';
  return importMarkdownText(text, seg);
}

export async function importMarkdownText(
  text: string,
  sourceFilename: string,
): Promise<ImportResult> {
  // 1. Parse + validate (throws FrontmatterError on any invalid input)
  const { frontmatter, body } = parsePlanMarkdown(text);

  const planner = usePlannerStore.getState();
  const versions = useSubjectVersionsStore.getState();

  // 2. Look up by subject_id
  const existing = planner.subjectRows.find((r) => r.id === frontmatter.subject_id);

  if (existing) {
    // ── Case A ─────────────────────────────────────────────────────────────
    // Make sure the versions store points at the right subject before
    // snapshotting. If currentSubjectId already matches, this is a no-op.
    if (versions.currentSubjectId !== existing.id) {
      await versions.loadForSubject(existing.id);
    }
    const newVersion = await useSubjectVersionsStore.getState().snapshotCurrent({
      contentMarkdown: body,
      source: 'import',
      sourceActor: frontmatter.source_actor ?? null,
      label: `Importado de ${sourceFilename}`,
      // Prefer the imported parent ref if the local store has it; otherwise
      // anchor to the local current version. See plan §"Phase D" for the
      // rationale on dangling parent refs.
      parentVersionId: frontmatter.parent_version_id ?? existing.currentVersionId ?? null,
    });
    if (!newVersion) {
      throw new Error('Snapshot insert failed during import (case A)');
    }
    return { kind: 'version_added', subjectId: existing.id, versionId: newVersion.id };
  }

  // ── Case B ───────────────────────────────────────────────────────────────
  // Parse "<project> / <file>" out of the title; split on the LAST ` / `
  // separator so project names that legitimately contain " / " round-trip
  // correctly (filenames generally don't, hence the right-most split).
  const titleStr = String(frontmatter.title ?? '').trim();
  let projectName: string;
  let fileNameRaw: string;
  const slashIdx = titleStr.lastIndexOf(' / ');
  if (slashIdx > 0) {
    projectName = titleStr.slice(0, slashIdx).trim();
    fileNameRaw = titleStr.slice(slashIdx + 3).trim();
  } else {
    projectName = FALLBACK_PROJECT_NAME;
    fileNameRaw = titleStr || sourceFilename.replace(/\.md$/i, '');
  }
  const fileName = fileNameRaw.endsWith('.md') ? fileNameRaw : `${fileNameRaw}.md`;

  // Create the project if missing
  if (!planner.projects.find((p) => p.name === projectName)) {
    // `path` left empty; user can fix it from the Planner UI later.
    // createProject also creates the local fs dir under
    // <appLocalData>/notter-ai/<accountId>/NotterProjects/<name>.
    await planner.createProject(projectName, '');
  }

  await planner.createSubject(projectName, fileName);
  await planner.saveSubjectContent(projectName, fileName, body);

  // Wait for the subject row to land. createSubject writes optimistically
  // and pushes to Supabase; the row arrives back via realtime which
  // populates `subjectRows`. Poll up to 5s (~20 attempts × 250ms).
  const subjectId = await waitForSubjectRow(projectName, fileName, 5000);
  if (!subjectId) {
    throw new ImportError('NO_VERSION_AFTER_TIMEOUT', projectName, fileName);
  }

  await useSubjectVersionsStore.getState().loadForSubject(subjectId);
  const newVersion = await useSubjectVersionsStore.getState().snapshotCurrent({
    contentMarkdown: body,
    source: 'import',
    sourceActor: frontmatter.source_actor ?? null,
    label: `Importado de ${sourceFilename}`,
    parentVersionId: null,
  });
  if (!newVersion) {
    throw new Error('Snapshot insert failed during import (case B)');
  }
  return { kind: 'subject_created', subjectId, versionId: newVersion.id };
}

async function waitForSubjectRow(
  projectName: string,
  fileName: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = usePlannerStore
      .getState()
      .subjectRows.find((r) => r.projectName === projectName && r.fileName === fileName);
    if (row) return row.id;
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}
