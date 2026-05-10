// src/components/McpConfigDialog.tsx
//
// Shows the current workspace's MCP config (URL + bearer token). This is the
// "Copy MCP config" affordance reachable from UserMenu. Phase J ships a
// dedicated WorkspaceManagerDialog with per-row copy; this dialog stays as a
// fast path for the active workspace.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useAuthStore } from '@/stores/auth-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { readMcpConfigForWorkspace, type McpWorkspaceConfig } from '@/lib/mcp';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function McpConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const [config, setConfig] = useState<McpWorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !user || !currentWorkspaceId) {
      setConfig(null);
      return;
    }
    setLoading(true);
    readMcpConfigForWorkspace(user.id, currentWorkspaceId)
      .then(setConfig)
      .finally(() => setLoading(false));
  }, [open, user, currentWorkspaceId]);

  const onCopy = async () => {
    if (!config) return;
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    toast.success(t('mcp.copied_toast'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('mcp.dialog_title')}</DialogTitle>
          <DialogDescription>{t('mcp.dialog_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {loading && <p className="text-sm text-muted-foreground">…</p>}
          {!loading && !config && (
            <div className="space-y-1">
              <p className="text-sm text-destructive font-medium">{t('mcp.disabled_banner')}</p>
              <p className="text-xs text-muted-foreground">{t('mcp.disabled_reason')}</p>
            </div>
          )}
          {config && (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('mcp.url_label')}</label>
                <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{config.url}</code>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('mcp.token_label')}</label>
                <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{config.bearer_token}</code>
              </div>
              <button
                onClick={onCopy}
                className="w-full mt-2 px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
              >
                {t('mcp.copy_button')}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
