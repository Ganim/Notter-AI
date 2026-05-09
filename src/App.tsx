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
import { initDeepLinkHandler } from '@/lib/deep-link';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './App.css';

function App() {
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    initialize();
    useAiStore.getState().initialize().catch(console.error);
    useActionsStore.getState().load().catch(console.error);
    initDeepLinkHandler().catch(console.error);

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
              flushActionsStore(),
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
