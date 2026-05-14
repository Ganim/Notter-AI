// src/components/settings/SettingsSideNav.tsx
//
// Vertical sidebar for the Settings dialog. 200px wide, slightly darker than
// the content (bg-muted/40). Five tab buttons; the active one uses the same
// `bg-accent text-accent-foreground` pair as the workspace switcher selection.
import { useTranslation } from 'react-i18next';
import { User, Sliders, Network, Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SettingsTab = 'account' | 'general' | 'mcp' | 'plugins';

interface Props {
  active: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}

const TABS: Array<{ id: SettingsTab; labelKey: string; Icon: typeof User }> = [
  { id: 'general', labelKey: 'settings.tabs.general', Icon: Sliders },
  { id: 'account', labelKey: 'settings.tabs.account', Icon: User },
  { id: 'mcp',     labelKey: 'settings.tabs.mcp',     Icon: Network },
  { id: 'plugins', labelKey: 'settings.tabs.plugins', Icon: Puzzle },
];

export function SettingsSideNav({ active, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <nav className="w-[240px] shrink-0 bg-muted/40 border-r border-border py-3 flex flex-col gap-0.5">
      {TABS.map(({ id, labelKey, Icon }) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={cn(
              'mx-2 px-3 py-2 rounded-md text-sm text-left flex items-center gap-2 transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
            )}
          >
            <Icon size={14} />
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
