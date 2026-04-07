import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAiStore } from '@/stores/ai-store';
import { OllamaPanel } from './OllamaPanel';

interface ManageAiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManageAiDialog({ open, onOpenChange }: ManageAiDialogProps) {
  const { t } = useTranslation();
  const status = useAiStore((s) => s.ollamaStatus);
  const refreshStatus = useAiStore((s) => s.refreshStatus);
  const refreshInstalledModels = useAiStore((s) => s.refreshInstalledModels);

  useEffect(() => {
    if (open) {
      refreshStatus().then(() => {
        if (useAiStore.getState().ollamaStatus === 'running') {
          refreshInstalledModels();
        }
      });
    }
  }, [open, refreshStatus, refreshInstalledModels]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-w-[calc(100%-2rem)] p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle>{t('manage_ai.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex h-[680px]">
          {/* Provider list (Phase 1: Ollama only) */}
          <div className="w-56 border-r border-border bg-muted/30 p-2">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {t('manage_ai.providers')}
            </div>
            <button className="w-full text-left px-2 py-1.5 rounded-md bg-accent text-sm font-medium flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  status === 'running'
                    ? 'bg-emerald-500'
                    : status === 'stopped'
                    ? 'bg-amber-500'
                    : 'bg-zinc-400'
                }`}
              />
              Ollama
            </button>
          </div>

          {/* Provider detail */}
          <div className="flex-1 min-w-0">
            <OllamaPanel />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
