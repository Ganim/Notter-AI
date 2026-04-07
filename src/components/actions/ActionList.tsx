import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useActionsStore } from '@/stores/actions-store';
import { ActionCard } from './ActionCard';

export function ActionList() {
  const { t } = useTranslation();
  const actions = useActionsStore((s) => s.actions);
  const selectedId = useActionsStore((s) => s.selectedActionId);
  const setSelected = useActionsStore((s) => s.setSelected);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.projectName.toLowerCase().includes(q) ||
        a.subjectName.toLowerCase().includes(q),
    );
  }, [actions, query]);

  return (
    <div className="flex flex-col h-full">
      {/* Search + counter */}
      <div className="border-b border-border px-3 py-2 space-y-2">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('actions.search_placeholder')}
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t('actions.counter', { count: filtered.length })}
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {filtered.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              selected={action.id === selectedId}
              onClick={() => setSelected(action.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
