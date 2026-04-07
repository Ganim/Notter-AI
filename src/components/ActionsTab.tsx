import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useActionsStore } from '@/stores/actions-store';
import { ActionList } from './actions/ActionList';
import { ActionDetail } from './actions/ActionDetail';

export function ActionsTab() {
  const { t } = useTranslation();
  const actions = useActionsStore((s) => s.actions);
  const loaded = useActionsStore((s) => s.loaded);

  if (loaded && actions.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-center px-4">
        <Sparkles size={48} className="text-muted-foreground/30 mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">{t('actions.empty_title')}</h2>
        <p className="text-sm text-muted-foreground max-w-sm">{t('actions.empty_subtitle')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-2">
        <h1 className="text-base font-semibold">{t('actions.title')}</h1>
      </div>
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize={35} minSize={20}>
            <ActionList />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={65} minSize={30}>
            <ActionDetail />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
