// src/components/settings/SettingsDialog.tsx
//
// Hosts the Settings UI as a dialog with a left sidebar (SettingsSideNav)
// and a right content area that swaps between the five Tab components.
// activeTab resets to initialTab on every open so re-entry is predictable.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsSideNav, type SettingsTab } from './SettingsSideNav';
import { AccountTab } from './tabs/AccountTab';
import { GeneralTab } from './tabs/GeneralTab';
import { McpTab } from './tabs/McpTab';
import { PluginsTab } from './tabs/PluginsTab';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTab;
}

export function SettingsDialog({ open, onOpenChange, initialTab = 'account' }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Reset to initialTab on every reopen so callers can deep-link without
  // residual state from a previous session.
  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [open, initialTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[min(960px,90vw)] w-[min(960px,90vw)] p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-[520px] max-h-[75vh]">
          <SettingsSideNav active={activeTab} onChange={setActiveTab} />
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'account' && <AccountTab />}
            {activeTab === 'general' && <GeneralTab />}
            {activeTab === 'mcp' && <McpTab />}
            {activeTab === 'plugins' && <PluginsTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
