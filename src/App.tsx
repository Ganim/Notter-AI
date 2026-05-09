import { useEffect } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/Layout';
import { PlannerTab } from '@/components/PlannerTab';
import { BoardTab } from '@/components/BoardTab';
import { AgentsTab } from '@/components/AgentsTab';
import { ActionsTab } from '@/components/ActionsTab';
import { TerminalsTab } from '@/components/TerminalsTab';
import { useAuthStore } from '@/stores/auth-store';
import { useAiStore } from '@/stores/ai-store';
import { useActionsStore, flushActionsStore } from '@/stores/actions-store';
import { useBoardStore } from '@/stores/board-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useAgentsStore } from '@/stores/agents-store';
import { useAppStore } from '@/stores/app-store';
import { initDeepLinkHandler } from '@/lib/deep-link';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getAccountManager } from '@/lib/accounts/account-manager';
import './App.css';

function App() {
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    (async () => {
      try {
        await getAccountManager().bootstrap();
      } catch (e) {
        console.error('[App] AccountManager.bootstrap failed', e);
      }
      initialize();
      useAiStore.getState().initialize().catch(console.error);
      useActionsStore.getState().load().catch(console.error);
      initDeepLinkHandler().catch(console.error);
    })();

    // Flush pending writes on window close to avoid losing the last
    // ~300ms of debounced edits. Hard-timeout the flush so a stuck
    // writeTextFile/rename never strands the window open after
    // event.preventDefault() — the X must always actually close.
    let unlistenClose: (() => void) | null = null;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlistenClose = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await Promise.race([
              Promise.all([
                flushActionsStore().catch((e) => console.error('[App] actions flush', e)),
                useBoardStore.getState().flush().catch((e) => console.error('[App] board flush', e)),
                usePlannerStore.getState().flush().catch((e) => console.error('[App] planner flush', e)),
                useAgentsStore.getState().flush().catch((e) => console.error('[App] agents flush', e)),
                useAppStore.getState().flush().catch((e) => console.error('[App] app flush', e)),
              ]),
              new Promise<void>((resolve) => setTimeout(resolve, 1500)),
            ]);
          } catch (e) {
            console.error('[App] flush on close failed', e);
          }
          // Unlisten before destroy so a second close event (if any) is
          // handled by Tauri's default path.
          unlistenClose?.();
          unlistenClose = null;
          await win.destroy();
        });
      } catch (e) {
        console.error('[App] could not register close handler', e);
      }
    })();

    return () => {
      unlistenClose?.();
    };
  }, [initialize]);

  return (
    <>
      <Toaster />
      <Layout>
        {{
          planner: <PlannerTab />,
          board: <BoardTab />,
          agents: <AgentsTab />,
          actions: <ActionsTab />,
          terminals: <TerminalsTab />,
        }}
      </Layout>
    </>
  );
}

export default App;
