import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { clearPendingStorage } from '@/lib/accounts/supabase-storage-adapter';
import { handleInviteDeepLink } from '@/lib/workspaces/invite-acceptor';

function handleAuthUrl(url: string) {
  if (!url.startsWith('notterai://auth/')) return;

  const parsed = new URL(url.replace('notterai://', 'https://'));

  let code = parsed.searchParams.get('code');
  let errorParam = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');

  if (!code && parsed.hash) {
    const hashParams = new URLSearchParams(parsed.hash.substring(1));
    code = hashParams.get('code');
    if (!errorParam) {
      errorParam = hashParams.get('error_description') || hashParams.get('error');
    }
  }

  if (errorParam) {
    toast.error('OAuth error: ' + errorParam);
    return;
  }
  if (!code) {
    toast.error('OAuth error: no code in callback URL');
    return;
  }

  supabase.auth.exchangeCodeForSession(code).then(async ({ data, error }) => {
    if (error) {
      console.error('[deep-link] exchangeCodeForSession error:', error);
      toast.error('OAuth error: ' + error.message);
      return;
    }
    if (data.session?.user && data.session.refresh_token) {
      const mgr = getAccountManager();
      const existing = mgr.get(data.session.user.id);
      if (!existing) {
        await mgr.add({
          id: data.session.user.id,
          email: data.session.user.email ?? '(unknown)',
          displayName: (data.session.user.user_metadata?.display_name as string | undefined) ?? null,
          refreshToken: data.session.refresh_token,
        });
      }
      await mgr.setActiveAccountId(data.session.user.id);
      // CRITICAL: re-persist under the now-active namespace.
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      // PKCE verifier was written under __pending__ before the account
      // existed; the verifier is now consumed, drop the stale entry.
      clearPendingStorage();
    }
  });
}

async function handleInviteUrl(url: string) {
  if (!url.startsWith('notterai://invite/')) return;
  const token = url.slice('notterai://invite/'.length).split('?')[0].split('#')[0];
  if (!token) {
    toast.error('Link de convite inválido');
    return;
  }
  const result = await handleInviteDeepLink(token);
  if (result.kind === 'redeemed') {
    toast.success(`Você entrou no workspace ${result.workspaceName}`);
  } else if (result.kind === 'signin_required') {
    toast(`Entre como ${result.preview.inviteeEmail} para aceitar o convite`);
  } else {
    toast.error(`Não foi possível aceitar o convite: ${result.message}`);
  }
}

async function dispatch(url: string) {
  if (url.startsWith('notterai://auth/')) {
    handleAuthUrl(url);
  } else if (url.startsWith('notterai://invite/')) {
    await handleInviteUrl(url);
  }
}

export async function initDeepLinkHandler() {
  // Handle URL the app was opened with (cold start)
  try {
    const initial = await getCurrent();
    if (initial && initial.length > 0) {
      for (const url of initial) await dispatch(url);
    }
  } catch (e) {
    console.error('[deep-link] getCurrent failed:', e);
  }

  // Handle URLs received while app is running
  await onOpenUrl((urls) => {
    for (const url of urls) {
      void dispatch(url);
    }
  });
}
