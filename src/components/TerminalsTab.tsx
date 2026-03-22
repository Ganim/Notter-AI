import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalsStore } from '@/stores/terminals-store';
import { usePlannerStore } from '@/stores/planner-store';
import { TerminalView, TerminalHandle } from '@/components/TerminalView';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Plus, Terminal as TerminalIcon, FolderOpen, Monitor } from 'lucide-react';
import { toast } from 'sonner';

export function TerminalsTab() {
  const { t } = useTranslation();
  const { consoles, addConsole, removeConsole } = useTerminalsStore();
  const { projects } = usePlannerStore();
  const terminalRefs = useRef<Record<string, TerminalHandle | null>>({});
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const handleOpenPicker = () => {
    if (consoles.length >= 4) {
      toast.error(t('terminals.max_consoles'));
      return;
    }
    setIsPickerOpen(true);
  };

  const handleSelectProject = (name: string, path: string) => {
    setIsPickerOpen(false);
    addConsole(name, path);
  };

  const handleOpenRoot = () => {
    setIsPickerOpen(false);
    addConsole('Terminal');
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
          onClick={handleOpenPicker}
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
                  cwd={c.cwd}
                  shell={c.shell}
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
              <button onClick={handleOpenPicker} className="text-primary hover:underline text-sm font-medium">{t('terminals.open_terminal')}</button>
            </div>
          )}
        </div>
      </div>

      {/* Project picker modal */}
      <Dialog open={isPickerOpen} onOpenChange={setIsPickerOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('terminals.new_console')}</DialogTitle>
            <DialogDescription>{t('terminals.where_to_open')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 mt-2">
            {projects.map((p) => (
              <button
                key={p.name}
                onClick={() => handleSelectProject(p.name, p.path)}
                className="w-full flex items-center gap-3 p-3 border border-border rounded-md hover:border-primary/50 hover:bg-primary/5 transition-all text-left group"
              >
                <div className="p-2 rounded-md bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                  <FolderOpen size={18} />
                </div>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{p.name}</span>
                  <span className="text-[10px] text-muted-foreground truncate">{p.path}</span>
                </div>
              </button>
            ))}

            <div className="border-t border-border my-1" />

            <button
              onClick={handleOpenRoot}
              className="w-full flex items-center gap-3 p-3 border border-border rounded-md hover:border-muted-foreground/50 hover:bg-muted/50 transition-all text-left group bg-muted/20"
            >
              <div className="p-2 rounded-md bg-muted text-muted-foreground group-hover:bg-foreground group-hover:text-background transition-colors">
                <Monitor size={18} />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-muted-foreground group-hover:text-foreground transition-colors">{t('terminals.open_in_root')}</span>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
