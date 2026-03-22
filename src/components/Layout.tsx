import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { UserMenu } from './UserMenu';

type Tab = 'planner' | 'board' | 'agents' | 'terminals';

const TABS: { key: Tab; labelKey: string }[] = [
  { key: 'planner', labelKey: 'nav.planner' },
  { key: 'board', labelKey: 'nav.board' },
  { key: 'agents', labelKey: 'nav.agents' },
  { key: 'terminals', labelKey: 'nav.terminals' },
];

interface LayoutProps {
  children: Record<Tab, React.ReactNode>;
}

export function Layout({ children }: LayoutProps) {
  const { t } = useTranslation();
  const { activeTab, setActiveTab } = useAppStore();

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      {/* Navbar */}
      <div className="h-12 shrink-0 border-b flex items-center justify-between px-4 bg-muted/40">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-zinc-200 dark:bg-zinc-700 text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <UserMenu />
      </div>

      {/* Content — all tabs stay mounted, only active is visible */}
      <div className="flex-1 overflow-hidden relative">
        {TABS.map((tab) => (
          <div
            key={tab.key}
            className={`absolute inset-0 ${activeTab === tab.key ? 'z-10 visible' : 'z-0 invisible'}`}
          >
            {children[tab.key]}
          </div>
        ))}
      </div>
    </div>
  );
}
