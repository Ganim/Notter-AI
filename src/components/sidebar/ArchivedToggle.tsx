import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';
import { usePlannerStore } from '@/stores/planner-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';

export function ArchivedToggle() {
  const { t } = useTranslation();
  const mode = usePlannerStore((s) => s.searchMode);
  const setMode = usePlannerStore((s) => s.setSearchMode);
  const allProjects = usePlannerStore((s) => s.allProjects);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);

  const archivedCount = useMemo(
    () =>
      allProjects.filter(
        (p) =>
          p.archivedAt &&
          (!currentWorkspaceId || p.workspaceId === currentWorkspaceId),
      ).length,
    [allProjects, currentWorkspaceId],
  );

  if (mode === 'archived') {
    return (
      <button
        onClick={() => setMode('active')}
        className="w-full flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
      >
        {t('archive.header_back')}
      </button>
    );
  }
  if (archivedCount === 0) return null;
  return (
    <button
      onClick={() => setMode('archived')}
      className="w-full flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
    >
      <Archive size={12} />
      {t('archive.footer_label', { count: archivedCount })}
    </button>
  );
}
