// src/components/WorkspaceMembersDialog.tsx
//
// Standalone members + invites dialog. Opened from WorkspaceSwitcher.
// Three sections:
//   1. Members list — everyone sees.
//   2. Pending invites — owner only.
//   3. Invite form — owner only.
// Plus a footer "Leave workspace" button — non-owners only.
//
// RBAC: this only HIDES affordances. The backend RLS + RPCs enforce the
// rules regardless of UI state. See:
//   - workspace_invites RLS (owner-only insert/update/delete)
//   - accept_workspace_invite (token + email-match guarded)
//   - get_workspace_members (peer-visibility via SECURITY DEFINER)
//   - leaveWorkspace (RLS allows self-delete; trigger blocks last-owner)
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchWorkspaceMembers,
  fetchPendingInvites,
  createWorkspaceInvite,
  revokeWorkspaceInvite,
  leaveWorkspace,
  generateInviteToken,
  sendInviteEmail,
} from '@/lib/sync';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceMembersDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentRole = useWorkspacesStore((s) => s.currentRole);
  const members = useWorkspacesStore((s) =>
    currentWorkspaceId ? s.members[currentWorkspaceId] ?? [] : [],
  );
  const pendingInvites = useWorkspacesStore((s) =>
    currentWorkspaceId ? s.pendingInvites[currentWorkspaceId] ?? [] : [],
  );
  const setMembers = useWorkspacesStore((s) => s.setWorkspaceMembers);
  const setInvites = useWorkspacesStore((s) => s.setPendingInvites);
  const user = useAuthStore((s) => s.user);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [submitting, setSubmitting] = useState(false);

  const isOwner = currentRole === 'owner';
  const currentWs = workspaces.find((w) => w.id === currentWorkspaceId) ?? null;

  useEffect(() => {
    if (!open || !currentWorkspaceId) return;
    void (async () => {
      const [m, inv] = await Promise.all([
        fetchWorkspaceMembers(currentWorkspaceId),
        isOwner ? fetchPendingInvites(currentWorkspaceId) : Promise.resolve(null),
      ]);
      if (m) setMembers(currentWorkspaceId, m);
      if (inv) setInvites(currentWorkspaceId, inv);
    })();
  }, [open, currentWorkspaceId, isOwner, setMembers, setInvites]);

  if (!currentWorkspaceId || !currentWs) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    );
  }

  const submitInvite = async () => {
    if (!inviteEmail.trim() || !currentWs) return;
    setSubmitting(true);
    try {
      const { token, tokenHash } = await generateInviteToken();
      const expiresAtIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const res = await createWorkspaceInvite({
        workspaceId: currentWorkspaceId,
        email: inviteEmail,
        role: inviteRole,
        tokenHash,
        expiresAtIso,
      });
      if (!res.ok) {
        toast.error(
          t(`workspaces.invite_error.${res.code}`, { defaultValue: res.message }),
        );
        return;
      }

      const emailRes = await sendInviteEmail({
        inviteId: res.id,
        workspaceId: currentWorkspaceId,
        workspaceName: currentWs.name,
        inviteeEmail: inviteEmail.trim().toLowerCase(),
        role: inviteRole,
        token,
        inviterDisplayName: user?.email ?? 'Notter',
      });
      if (!emailRes.ok) {
        toast.warning(
          t('workspaces.invite_email_failed', {
            defaultValue: 'Convite criado mas email falhou; copie o link manualmente',
          }),
        );
      } else {
        toast.success(t('workspaces.invite_sent', { defaultValue: 'Convite enviado' }));
      }
      setInviteEmail('');

      // Refresh pending invites so the new row shows up immediately (realtime
      // will catch up too, but the dialog feels snappier with a direct refetch).
      const inv = await fetchPendingInvites(currentWorkspaceId);
      if (inv) setInvites(currentWorkspaceId, inv);
    } finally {
      setSubmitting(false);
    }
  };

  const onRevoke = async (id: string) => {
    const r = await revokeWorkspaceInvite(id);
    if (!r.ok) {
      toast.error(r.message ?? t('workspaces.revoke_failed', { defaultValue: 'Falha ao revogar' }));
      return;
    }
    setInvites(currentWorkspaceId, pendingInvites.filter((i) => i.id !== id));
  };

  const onLeave = async () => {
    const r = await leaveWorkspace(currentWorkspaceId);
    if (!r.ok) {
      toast.error(r.message ?? t('workspaces.leave_failed', { defaultValue: 'Falha ao sair' }));
      return;
    }
    toast.success(t('workspaces.left', { defaultValue: 'Você saiu do workspace' }));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('workspaces.members_title', {
              defaultValue: 'Membros de {{name}}',
              replace: { name: currentWs.name },
            })}
          </DialogTitle>
        </DialogHeader>

        {/* Members list */}
        <ul className="space-y-2 mb-4 max-h-64 overflow-y-auto">
          {members.length === 0 && (
            <li className="text-sm text-muted-foreground italic">
              {t('workspaces.members_loading', { defaultValue: 'Carregando…' })}
            </li>
          )}
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 text-sm">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs">
                {m.displayName?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  {m.displayName}
                  {m.userId === user?.id
                    ? ` (${t('workspaces.you', { defaultValue: 'você' })})`
                    : ''}
                </div>
                <div className="text-xs text-muted-foreground truncate">{m.email}</div>
              </div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {m.role}
              </span>
            </li>
          ))}
        </ul>

        {/* Pending invites (owner only) */}
        {isOwner && pendingInvites.length > 0 && (
          <>
            <h3 className="text-sm font-semibold mb-2 mt-4">
              {t('workspaces.pending_invites', { defaultValue: 'Convites pendentes' })}
            </h3>
            <ul className="space-y-2 mb-4">
              {pendingInvites.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 text-sm">
                  <div className="flex-1 truncate">
                    {inv.email}{' '}
                    <span className="text-xs text-muted-foreground">({inv.role})</span>
                  </div>
                  <button
                    onClick={() => onRevoke(inv.id)}
                    className="text-xs text-destructive hover:underline"
                  >
                    {t('workspaces.revoke', { defaultValue: 'Revogar' })}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Invite form (owner only) */}
        {isOwner && (
          <div className="border-t pt-4 mt-2">
            <h3 className="text-sm font-semibold mb-2">
              {t('workspaces.invite_member', { defaultValue: 'Convidar membro' })}
            </h3>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder={t('workspaces.email_placeholder', {
                  defaultValue: 'email@exemplo.com',
                })}
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              >
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <Button
                onClick={submitInvite}
                disabled={submitting || !inviteEmail.trim()}
                size="sm"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('workspaces.send_invite', { defaultValue: 'Enviar' })
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Leave (non-owners) */}
        {!isOwner && (
          <div className="border-t pt-4 mt-2">
            <Button variant="destructive" size="sm" onClick={onLeave}>
              {t('workspaces.leave_button', { defaultValue: 'Sair do workspace' })}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
