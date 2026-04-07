import { useEffect } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/Layout';
import { PlannerTab } from '@/components/PlannerTab';
import { BoardTab } from '@/components/BoardTab';
import { AgentsTab } from '@/components/AgentsTab';
import { TerminalsTab } from '@/components/TerminalsTab';
import { useAuthStore } from '@/stores/auth-store';
import { initDeepLinkHandler } from '@/lib/deep-link';
import './App.css';

function App() {
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    initialize();
    initDeepLinkHandler().catch(console.error);
  }, [initialize]);

  return (
    <>
      <Toaster />
      <Layout>
        {{
          planner: <PlannerTab />,
          board: <BoardTab />,
          agents: <AgentsTab />,
          terminals: <TerminalsTab />,
        }}
      </Layout>
    </>
  );
}

export default App;
