import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAiStore } from '@/stores/ai-store';
import { CLOUD_PROVIDERS, type CloudProviderId, type ProviderId } from '@/lib/ai-providers';
import { OllamaPanel } from './OllamaPanel';
import { CloudProviderPanel } from './CloudProviderPanel';

interface ManageAiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManageAiDialog({ open, onOpenChange }: ManageAiDialogProps) {
  const { t } = useTranslation();
  const status = useAiStore((s) => s.ollamaStatus);
  const activeProviderId = useAiStore((s) => s.activeProviderId);
  const cloudConfigs = useAiStore((s) => s.cloudConfigs);
  const refreshStatus = useAiStore((s) => s.refreshStatus);
  const refreshInstalledModels = useAiStore((s) => s.refreshInstalledModels);

  // Selected provider in the sidebar (independent of which is currently "active")
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('ollama');

  useEffect(() => {
    if (open) {
      refreshStatus().then(() => {
        if (useAiStore.getState().ollamaStatus === 'running') {
          refreshInstalledModels();
        }
      });
    }
  }, [open, refreshStatus, refreshInstalledModels]);

  // When the dialog opens, jump to the currently active provider so the
  // user can immediately tweak the one they're using
  useEffect(() => {
    if (open) {
      setSelectedProvider(activeProviderId);
    }
  }, [open, activeProviderId]);

  function ollamaDot() {
    if (status === 'running') return 'bg-emerald-500';
    if (status === 'stopped') return 'bg-amber-500';
    return 'bg-zinc-400';
  }

  function cloudDot(id: CloudProviderId) {
    const cfg = cloudConfigs[id];
    if (!cfg?.apiKey.trim()) return 'bg-zinc-400';
    if (activeProviderId === id) return 'bg-emerald-500';
    return 'bg-sky-500';
  }

  function ProviderButton({
    id,
    label,
    dot,
  }: {
    id: ProviderId;
    label: string;
    dot: string;
  }) {
    const isSelected = selectedProvider === id;
    const isActive = activeProviderId === id;
    return (
      <button
        onClick={() => setSelectedProvider(id)}
        className={`w-full text-left px-2 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-colors ${
          isSelected
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className="truncate flex-1">{label}</span>
        {isActive && (
          <span className="text-[9px] uppercase font-bold tracking-wider text-emerald-600 dark:text-emerald-400">
            ●
          </span>
        )}
      </button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-w-[calc(100%-2rem)] p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle>{t('manage_ai.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex h-[680px]">
          {/* Provider list grouped by Local / Online */}
          <div className="w-56 border-r border-border bg-muted/30 flex flex-col">
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-3">
                <div>
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {t('manage_ai.local_providers')}
                  </div>
                  <ProviderButton id="ollama" label="Ollama" dot={ollamaDot()} />
                </div>
                <div>
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {t('manage_ai.online_providers')}
                  </div>
                  {CLOUD_PROVIDERS.map((p) => (
                    <ProviderButton key={p.id} id={p.id} label={p.name} dot={cloudDot(p.id)} />
                  ))}
                </div>
              </div>
            </ScrollArea>
          </div>

          {/* Provider detail */}
          <div className="flex-1 min-w-0">
            {selectedProvider === 'ollama' ? (
              <OllamaPanel />
            ) : (
              <CloudProviderPanel providerId={selectedProvider} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
