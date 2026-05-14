// src/components/settings/McpManualSection.tsx
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export function McpManualSection({ mcpUrl }: { mcpUrl: string | null }) {
  const { t } = useTranslation();
  const onCopy = async () => {
    if (!mcpUrl) return;
    await navigator.clipboard.writeText(mcpUrl);
    toast.success('Copied');
  };
  return (
    <div className="pt-4 mt-4 border-t">
      <div className="text-sm font-medium text-foreground mb-1">{t('mcp.manual.title')}</div>
      <p className="text-xs text-muted-foreground mb-2">{t('mcp.manual.instructions')}</p>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('mcp.manual.url_label')}</label>
        <div className="flex gap-2">
          <code className="flex-1 text-xs bg-muted rounded px-2 py-1 break-all">{mcpUrl ?? '…'}</code>
          <button onClick={onCopy} disabled={!mcpUrl}
            className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50">
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
