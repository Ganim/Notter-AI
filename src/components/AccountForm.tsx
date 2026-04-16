import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/auth-store';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { toast } from 'sonner';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormState {
  displayName: string;
  email: string;
}

interface FormErrors {
  displayName?: string;
  email?: string;
}

/**
 * Account (Conta) settings form.
 *
 * Reads/writes to Supabase Auth ONLY (auth.users + user_metadata) — no custom
 * profile table is created or required. Updatable fields are explicitly
 * whitelisted (display_name, email) to prevent mass assignment. The Supabase
 * auth.updateUser() call is intrinsically scoped to the currently authenticated
 * user, so no other user's data can be reached.
 */
export function AccountForm() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const [form, setForm] = useState<FormState>({ displayName: '', email: '' });
  const [initial, setInitial] = useState<FormState>({ displayName: '', email: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Hydrate from current authenticated user on mount / when auth changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!isSupabaseConfigured) {
        if (!cancelled) setLoading(false);
        return;
      }
      // Verify session before any read.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        if (!cancelled) setLoading(false);
        return;
      }
      const { data, error } = await supabase.auth.getUser();
      if (cancelled) return;
      if (error || !data.user) {
        setLoading(false);
        return;
      }
      const next: FormState = {
        displayName: (data.user.user_metadata?.display_name as string) || '',
        email: data.user.email || '',
      };
      setForm(next);
      setInitial(next);
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const validate = (state: FormState): FormErrors => {
    const errs: FormErrors = {};
    if (!state.displayName.trim()) {
      errs.displayName = t('account.error_required');
    }
    if (!state.email.trim()) {
      errs.email = t('account.error_required');
    } else if (!EMAIL_RE.test(state.email.trim())) {
      errs.email = t('account.error_invalid_email');
    }
    return errs;
  };

  const dirty = form.displayName !== initial.displayName || form.email !== initial.email;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (!isSupabaseConfigured) {
      toast.error(t('account.error_not_configured'));
      return;
    }
    // Re-verify session before write.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      toast.error(t('account.error_not_authenticated'));
      return;
    }

    setSaving(true);

    // WHITELIST: only these two fields are forwarded to Supabase. Never spread
    // `form` or any arbitrary object into updateUser().
    const payload: { email?: string; data?: { display_name: string } } = {};
    if (form.displayName.trim() !== initial.displayName) {
      payload.data = { display_name: form.displayName.trim() };
    }
    if (form.email.trim() !== initial.email) {
      payload.email = form.email.trim();
    }

    if (!payload.email && !payload.data) {
      setSaving(false);
      return;
    }

    const { data, error } = await supabase.auth.updateUser(payload);
    setSaving(false);

    if (error) {
      toast.error(t('account.save_error'));
      return;
    }

    const updated: FormState = {
      displayName: (data.user?.user_metadata?.display_name as string) || form.displayName.trim(),
      email: data.user?.email || form.email.trim(),
    };
    setForm(updated);
    setInitial(updated);
    toast.success(t('account.save_success'));
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        {t('account.not_signed_in')}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <h3 className="text-sm font-semibold text-foreground border-b border-border pb-2">
        {t('account.title')}
      </h3>

      <div className="space-y-2">
        <Label className="text-xs">{t('account.display_name')}</Label>
        <input
          type="text"
          value={form.displayName}
          disabled={saving}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          className="w-full bg-background border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        {errors.displayName && (
          <p className="text-xs text-destructive">{errors.displayName}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('account.email')}</Label>
        <input
          type="email"
          value={form.email}
          disabled={saving}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="w-full bg-background border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email}</p>
        )}
        <p className="text-[11px] text-muted-foreground">{t('account.email_hint')}</p>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving || !dirty}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {!saving && dirty && <CheckCircle2 size={14} />}
          {t('account.save')}
        </button>
        {!dirty && !saving && (
          <span className="text-xs text-muted-foreground">{t('account.no_changes')}</span>
        )}
      </div>
    </form>
  );
}
