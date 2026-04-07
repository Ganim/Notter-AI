import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

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

  supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
    if (error) {
      console.error('[deep-link] exchangeCodeForSession error:', error);
      toast.error('OAuth error: ' + error.message);
    }
  });
}

export async function initDeepLinkHandler() {
  // Handle URL the app was opened with (cold start)
  try {
    const initial = await getCurrent();
    if (initial && initial.length > 0) {
      for (const url of initial) handleAuthUrl(url);
    }
  } catch (e) {
    console.error('[deep-link] getCurrent failed:', e);
  }

  // Handle URLs received while app is running
  await onOpenUrl((urls) => {
    for (const url of urls) handleAuthUrl(url);
  });
}
