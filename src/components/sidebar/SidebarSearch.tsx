// src/components/sidebar/SidebarSearch.tsx
import { useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import {
  usePlannerStore,
  selectSubjectSearchHits,
  selectExactIdentifierMatch,
} from '@/stores/planner-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { TagChip } from '@/components/sidebar/TagChip';
import { subjectIdentifier, parseIdentifier } from '@/lib/identifiers';

export interface SidebarSearchProps {
  /** Called when the user picks a subject hit or jumps to an exact identifier. */
  onJumpSubject: (projectName: string, fileName: string) => void;
}

export function SidebarSearch({ onJumpSubject }: SidebarSearchProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // Read stable primitive slices to drive local derivations.
  const query = usePlannerStore((s) => s.searchQuery);
  const setQuery = usePlannerStore((s) => s.setSearchQuery);
  const searchMode = usePlannerStore((s) => s.searchMode);
  const allProjects = usePlannerStore((s) => s.allProjects);
  const subjectRows = usePlannerStore((s) => s.subjectRows);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);

  const identifierShape = parseIdentifier(query.trim().toLowerCase());

  // Derive subject hits locally so we control memoisation.
  const subjectHits = useMemo(() => {
    return selectSubjectSearchHits({ searchQuery: query, searchMode, allProjects, subjectRows } as any);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchMode, allProjects, subjectRows, currentWorkspaceId]);

  // Derive exact identifier match locally.
  const exactMatch = useMemo(() => {
    return selectExactIdentifierMatch({ searchQuery: query, allProjects, subjectRows } as any);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, allProjects, subjectRows, currentWorkspaceId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        setQuery('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setQuery]);

  return (
    <div className="space-y-2 px-2 pt-2">
      <div className="relative">
        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          className="w-full pl-7 pr-7 py-1 text-sm border rounded bg-background"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && exactMatch) {
              onJumpSubject(exactMatch.project.name, exactMatch.subject.fileName);
              setQuery('');
            }
          }}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {identifierShape && (
        <button
          disabled={!exactMatch}
          onClick={() => {
            if (exactMatch) {
              onJumpSubject(exactMatch.project.name, exactMatch.subject.fileName);
              setQuery('');
            }
          }}
          className="w-full text-left px-2 py-1.5 text-xs rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-default"
        >
          {exactMatch
            ? t('search.open_identifier', { id: subjectIdentifier(exactMatch.subject, exactMatch.project) })
            : t('search.identifier_not_found', { id: query })}
        </button>
      )}

      {query && subjectHits.length > 0 && (
        <div className="space-y-1">
          <div className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('search.results_subjects', { count: subjectHits.length })}
          </div>
          {subjectHits.map((h) => (
            <button
              key={`${h.project.name}/${h.subject.fileName}`}
              onClick={() => {
                onJumpSubject(h.project.name, h.subject.fileName);
                setQuery('');
              }}
              className="w-full flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted text-left"
            >
              <TagChip tag={h.project.tag} className="shrink-0" />
              <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                {subjectIdentifier(h.subject, h.project)}
              </span>
              <span className="truncate">{h.subject.fileName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
