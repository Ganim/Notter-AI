import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/Layout';
import { PlannerTab } from '@/components/PlannerTab';
import { BoardTab } from '@/components/BoardTab';
import { AgentsTab } from '@/components/AgentsTab';
import { TerminalsTab } from '@/components/TerminalsTab';
import './App.css';

function App() {
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
