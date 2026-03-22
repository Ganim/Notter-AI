import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalsStore } from '@/stores/terminals-store';
import { TerminalView, TerminalHandle } from '@/components/TerminalView';
import { Plus, Terminal as TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';

export function TerminalsTab() {
  const { t } = useTranslation();
  const { consoles, addConsole, removeConsole } = useTerminalsStore();
  const terminalRefs = useRef<Record<string, TerminalHandle | null>>({});

  const handleAddConsole = () => {
    const id = addConsole();
    if (!id) toast.error(t('terminals.max_consoles'));
  };

  const handleRemoveConsole = (id: string) => {
    removeConsole(id);
    delete terminalRefs.current[id];
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b flex items-center justify-between px-4 bg-muted/20 shrink-0">
        <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{t('terminals.console_map')}</span>
        <button
          onClick={handleAddConsole}
          disabled={consoles.length >= 4}
          className="bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1.5 rounded-sm flex items-center text-xs space-x-1 font-medium transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={14} /><span>{t('terminals.new_console')}</span>
        </button>
      </div>

      <div className="relative bg-background overflow-hidden w-full flex-1">
        <div className="absolute inset-4 flex flex-wrap gap-4 content-start">
          {consoles.map((c) => {
            const isTwoCols = consoles.length > 1;
            const isTwoRows = consoles.length > 2;
            const w = isTwoCols ? 'calc(50% - 0.5rem)' : '100%';
            const h = isTwoRows ? 'calc(50% - 0.5rem)' : '100%';

            return (
              <div key={c.id} style={{ width: w, height: h }} className="flex flex-col">
                <TerminalView
                  id={c.id}
                  name={c.name}
                  onClose={handleRemoveConsole}
                  ref={(el) => { terminalRefs.current[c.id] = el; }}
                />
              </div>
            );
          })}
          {consoles.length === 0 && (
            <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <TerminalIcon size={48} className="opacity-20" />
              <p className="text-sm font-medium">{t('terminals.no_consoles')}</p>
              <button onClick={handleAddConsole} className="text-primary hover:underline text-sm font-medium">{t('terminals.open_terminal')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
