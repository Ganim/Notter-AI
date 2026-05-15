// supabase/functions/send-workspace-invite/index.ts
//
// Sends a workspace invite email via Resend. Called by the client AFTER it
// has successfully inserted into workspace_invites. The token is supplied by
// the client (it's the raw value used for the URL) — the DB only stores the
// SHA-256 hash, so the function never round-trips through workspace_invites
// to fetch the token.
//
// Auth: callers must be authenticated. The function verifies that the caller
// is the owner of the workspace (matches the workspace_invites RLS guard).
// Codex Finding #2: it ALSO re-fetches the invite row and verifies every
// payload field against the DB so an owner cannot send arbitrary tuples.
//
// Env:
//   RESEND_API_KEY   — Resend API key (Supabase secret)
//   RESEND_FROM      — Verified Resend sender, e.g. "Notter <invites@notter.ai>"
//   APP_DEEP_LINK    — Defaults to "notterai://invite". Override per environment.

import { createClient } from '@supabase/supabase-js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface InvitePayload {
  invite_id: string;
  workspace_id: string;
  invitee_email: string;
  role: 'editor' | 'viewer';
  token: string; // raw, NOT hash
  inviter_display_name: string;
  workspace_name: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const RESEND_FROM    = Deno.env.get('RESEND_FROM') ?? 'Notter <onboarding@resend.dev>';
  const APP_DEEP_LINK  = Deno.env.get('APP_DEEP_LINK') ?? 'notterai://invite';
  if (!RESEND_API_KEY) return json({ error: 'resend_not_configured' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthenticated' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const payload = (await req.json().catch(() => null)) as InvitePayload | null;
  if (!payload) return json({ error: 'invalid_payload' }, 400);

  // workspace_role() executes as the caller; verifies they're owner of this ws.
  const { data: role, error: roleErr } = await supabase.rpc('workspace_role', {
    ws_id: payload.workspace_id,
  });
  if (roleErr || role !== 'owner') return json({ error: 'forbidden' }, 403);

  // Codex Finding #2: the owner-of-workspace check is necessary but not
  // sufficient — without binding the payload to a real workspace_invites row,
  // an owner could send arbitrary (email, role, token) tuples. Re-fetch the
  // invite by id (scoped to the workspace) and verify every payload field
  // before composing the email. token is hashed and compared to token_hash.
  const tokenHashBuf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(payload.token),
  );
  const tokenHashHex = Array.from(new Uint8Array(tokenHashBuf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const { data: inviteRow, error: inviteErr } = await supabase
    .from('workspace_invites')
    .select('email, role, token_hash, accepted_at, revoked_at')
    .eq('id', payload.invite_id)
    .eq('workspace_id', payload.workspace_id)
    .maybeSingle();
  if (inviteErr || !inviteRow) return json({ error: 'invite_not_found' }, 404);
  if (inviteRow.accepted_at || inviteRow.revoked_at) return json({ error: 'invite_not_open' }, 409);
  if (inviteRow.token_hash !== tokenHashHex)         return json({ error: 'token_mismatch' }, 400);
  if (inviteRow.email.toLowerCase() !== payload.invitee_email.toLowerCase()) {
    return json({ error: 'email_mismatch' }, 400);
  }
  if (inviteRow.role !== payload.role) return json({ error: 'role_mismatch' }, 400);

  const link = `${APP_DEEP_LINK}/${payload.token}`;
  const safeName = escapeHtml(payload.workspace_name);
  const safeInviter = escapeHtml(payload.inviter_display_name);

  // Codex Finding #3: strip CRLF from subject-line interpolations to prevent
  // header injection into the Resend API call. HTML body is already escaped.
  const cleanPart = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const subject = `${cleanPart(payload.inviter_display_name)} convidou você para o workspace ${cleanPart(payload.workspace_name)}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px">Convite para um workspace no Notter</h2>
      <p>${safeInviter} adicionou você como <b>${payload.role}</b> no workspace <b>${safeName}</b>.</p>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">
          Abrir convite no Notter
        </a>
      </p>
      <p style="color:#666;font-size:13px">
        Se o botão não funcionar, copie o link:<br>
        <code>${link}</code>
      </p>
      <p style="color:#999;font-size:12px;margin-top:32px">
        Este convite expira em 7 dias. Se você não reconhece o remetente, ignore este email.
      </p>
    </div>
  `;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [payload.invitee_email],
      subject,
      html,
    }),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text().catch(() => '');
    return json({ error: 'resend_failed', detail, status: resendRes.status }, 502);
  }

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
