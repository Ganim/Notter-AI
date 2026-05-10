// src/components/PlansTab.tsx
import { PlanList } from '@/components/plans/PlanList';
import { PlanEditor } from '@/components/plans/PlanEditor';
import { SnapshotPanel } from '@/components/plans/SnapshotPanel';
import { CommentsPanel } from '@/components/plans/CommentsPanel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';

export function PlansTab() {
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      {/* Left sidebar: plan list */}
      <ResizablePanel defaultSize={20} minSize={15} maxSize={30}>
        <PlanList />
      </ResizablePanel>

      <ResizableHandle />

      {/* Center: Monaco editor */}
      <ResizablePanel defaultSize={50} minSize={30}>
        <PlanEditor />
      </ResizablePanel>

      <ResizableHandle />

      {/* Right sidebar: snapshots + comments */}
      <ResizablePanel defaultSize={30} minSize={20} maxSize={40}>
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel defaultSize={50}>
            <SnapshotPanel />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={50}>
            <CommentsPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
