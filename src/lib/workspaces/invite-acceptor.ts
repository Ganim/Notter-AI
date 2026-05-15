// src/lib/workspaces/invite-acceptor.ts
//
// Handles the notterai://invite/<token> deep link. Pure TS (no Tauri imports)
// so the same module works in a future web shell — the Tauri-side handler
// just parses the URL and calls into here.
import { acceptWorkspaceInvite, fetchInvitePreview } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { useWorkspacesStore } from '@/stores/workspaces-store';

export interface PendingInvite {
  token: string;
  tokenHash: string;
  workspaceName: string;
  inviteeEmail: string;
}

let pendingInvite: PendingInvite | null = null;

/**
 * Compute SHA-256 of the raw token. Browser-native; works in Tauri WebView.
 * Output matches Postgres `encode(digest(token, 'sha256'), 'hex')`.
 */
async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getPendingInvite(): PendingInvite | null {
  return pendingInvite;
}

export function clearPendingInvite(): void {
  pendingInvite = null;
}

/**
 * Entry point for the Tauri deep-link handler.
 *   notterai://invite/<token>
 *
 * Three exit states:
 *   - signin_required: user is signed out; the preview is captured for
 *     redeemPendingInviteAfterSignIn() to consume after auth completes.
 *   - redeemed: user is signed in with the matching email; the invite is
 *     accepted, the workspace manager bootstraps, and the switch happens.
 *   - error: anything else (mismatch, expired, revoked, not found).
 */
export async function handleInviteDeepLink(token: string): Promise<
  | { kind: 'signin_required'; preview: PendingInvite }
  | { kind: 'redeemed'; workspaceId: string; workspaceName: string }
  | { kind: 'error'; message: string }
> {
  const tokenHash = await hashToken(token);
  const previewRes = await fetchInvitePreview(tokenHash);
  if (!previewRes.ok) {
    return { kind: 'error', message: previewRes.message };
  }
  const preview: PendingInvite = {
    token,
    tokenHash,
    workspaceName: previewRes.workspaceName,
    inviteeEmail: previewRes.inviteeEmail,
  };

  const user = useAuthStore.getState().user;
  if (!user) {
    pendingInvite = preview;
    return { kind: 'signin_required', preview };
  }

  if (user.email?.toLowerCase() !== preview.inviteeEmail.toLowerCase()) {
    return {
      kind: 'error',
      message: `Este convite é para ${preview.inviteeEmail}. Saia da conta atual e entre como ${preview.inviteeEmail}.`,
    };
  }

  const acceptRes = await acceptWorkspaceInvite(token);
  if (!acceptRes.ok) {
    return { kind: 'error', message: acceptRes.code };
  }

  // Refresh workspaces + switch to the joined one.
  await getWorkspaceManager().bootstrap();
  await getWorkspaceManager().switchWorkspace(acceptRes.workspaceId);
  useWorkspacesStore.getState().setCurrentWorkspaceId(acceptRes.workspaceId);

  return {
    kind: 'redeemed',
    workspaceId: acceptRes.workspaceId,
    workspaceName: preview.workspaceName,
  };
}

/**
 * After successful sign-in, the auth flow calls this to redeem any pending
 * invite captured by `handleInviteDeepLink` while the user was signed out.
 */
export async function redeemPendingInviteAfterSignIn(): Promise<
  | { kind: 'none' }
  | { kind: 'redeemed'; workspaceId: string; workspaceName: string }
  | { kind: 'error'; message: string }
> {
  if (!pendingInvite) return { kind: 'none' };
  const token = pendingInvite.token;
  pendingInvite = null;
  const r = await handleInviteDeepLink(token);
  if (r.kind === 'redeemed') return r;
  if (r.kind === 'error') return r;
  // signin_required after sign-in is illogical; treat as error.
  return { kind: 'error', message: 'invite_state_unexpected' };
}
