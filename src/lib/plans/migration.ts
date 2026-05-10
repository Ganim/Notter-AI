// src/lib/plans/migration.ts (stub — full implementation in Phase F2)
export interface MigrationResult {
  skipped: boolean;
  migrated: number;
  failed: { projectName: string; fileName: string; error: string }[];
}

export async function migrateSubjectsToPlans(_userId: string): Promise<MigrationResult> {
  return { skipped: true, migrated: 0, failed: [] };
}
