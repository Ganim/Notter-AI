// src/components/plans/PlanEditor.tsx
import { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { usePlanStore } from '@/stores/plan-store';
import { useAppStore } from '@/stores/app-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from 'react-i18next';
import { Camera } from 'lucide-react';
import { toast } from 'sonner';

export function PlanEditor() {
  const { t } = useTranslation();
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const workingDraft = usePlanStore((s) => s.workingDraft);
  const updateWorkingDraft = usePlanStore((s) => s.updateWorkingDraft);
  const snapshotCurrent = usePlanStore((s) => s.snapshotCurrent);
  const darkMode = useAppStore((s) => s.darkMode);

  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [snapshotting, setSnapshotting] = useState(false);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  const handleSnapshot = async () => {
    setSnapshotting(true);
    await snapshotCurrent(snapshotLabel.trim() || undefined);
    setSnapshotLabel('');
    setSnapshotting(false);
    toast.success('Snapshot saved');
  };

  if (!currentPlanId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        {t('plans.no_plans')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <Input
          value={snapshotLabel}
          onChange={(e) => setSnapshotLabel(e.target.value)}
          placeholder={t('plans.snapshot_label_placeholder')}
          className="h-7 text-xs w-48"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSnapshot(); }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-3 text-xs gap-1"
          onClick={handleSnapshot}
          disabled={snapshotting}
        >
          <Camera className="w-3 h-3" />
          {t('plans.snapshot_now')}
        </Button>
      </div>

      {/* Monaco editor */}
      <div className="flex-1 overflow-hidden">
        <Editor
          language="markdown"
          theme={darkMode ? 'vs-dark' : 'vs'}
          value={workingDraft}
          onChange={(val) => updateWorkingDraft(val ?? '')}
          onMount={(editor) => { editorRef.current = editor; }}
          options={{
            wordWrap: 'on',
            minimap: { enabled: false },
            lineNumbers: 'off',
            folding: true,
            fontSize: 14,
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
