import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { UserMenu } from './UserMenu';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { WindowControls } from './WindowControls';

type Tab = 'planner';

const isDev = import.meta.env.DEV;

const TABS: { key: Tab; labelKey: string }[] = [
  { key: 'planner', labelKey: 'nav.planner' },
];

interface LayoutProps {
  children: Record<Tab, React.ReactNode>;
}

export function Layout({ children }: LayoutProps) {
  const { t } = useTranslation();
  const { activeTab, setActiveTab } = useAppStore();

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      {/* Navbar — the explicit flex-1 spacer between the two groups carries
          `data-tauri-drag-region` so dragging the window from the empty header
          area always works. Interactive children explicitly opt out. */}
      <div className="h-12 shrink-0 border-b flex items-center px-4 bg-muted/40">
        <div className="flex items-center gap-2" data-tauri-drag-region="false">
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
          {isDev && (
            <span className="ml-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/40">
              DEV-MODE
            </span>
          )}
        </div>
        <div
          data-tauri-drag-region="true"
          className="flex-1 h-full self-stretch"
          aria-hidden
        />
        <div className="flex items-center gap-1" data-tauri-drag-region="false">
          <WorkspaceSwitcher />
          <UserMenu />
          <WindowControls />
        </div>
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
