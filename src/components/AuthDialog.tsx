import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth-store';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  const { t } = useTranslation();
  const { signInWithEmail, signUpWithEmail, signInWithOAuth, configured } = useAuthStore();
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setError('');
    setLoading(false);
  };

  const handleLogin = async () => {
    setError('');
    setLoading(true);
    const result = await signInWithEmail(email, password);
    setLoading(false);
    if (result.error) {
      setError(t(`auth.error_${result.error}`));
    } else {
      toast.success(t('auth.login_success'));
      resetForm();
      onOpenChange(false);
    }
  };

  const handleSignup = async () => {
    setError('');
    if (password !== confirmPassword) {
      setError(t('auth.error_passwords_mismatch'));
      return;
    }
    setLoading(true);
    const result = await signUpWithEmail(email, password);
    setLoading(false);
    if (result.error) {
      setError(t(`auth.error_${result.error}`));
    } else {
      toast.success(t('auth.signup_success'));
      resetForm();
      onOpenChange(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError('');
    const result = await signInWithOAuth(provider);
    if (result.error) {
      setError(t(`auth.error_${result.error}`));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'login') handleLogin();
    else handleSignup();
  };

  return (
    <Dialog open={open} onOpenChange={(val) => { onOpenChange(val); if (!val) resetForm(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{tab === 'login' ? t('auth.login') : t('auth.sign_up')}</DialogTitle>
        </DialogHeader>

        {!configured ? (
          <p className="text-sm text-destructive py-4">{t('auth.error_not_configured')}</p>
        ) : (
          <>
            {/* Tab switcher */}
            <div className="flex gap-1 bg-muted rounded-md p-1">
              <button
                onClick={() => { setTab('login'); setError(''); }}
                className={`flex-1 py-1.5 text-sm font-medium rounded transition-colors ${tab === 'login' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('auth.login')}
              </button>
              <button
                onClick={() => { setTab('signup'); setError(''); }}
                className={`flex-1 py-1.5 text-sm font-medium rounded transition-colors ${tab === 'signup' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('auth.sign_up')}
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
              <div className="flex flex-col gap-1.5">
                <Label>{t('auth.email')}</Label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="bg-background border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>{t('auth.password')}</Label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="bg-background border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              {tab === 'signup' && (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('auth.confirm_password')}</Label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={6}
                    className="bg-background border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              )}

              {error && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {loading
                  ? (tab === 'login' ? t('auth.logging_in') : t('auth.signing_up'))
                  : (tab === 'login' ? t('auth.login_button') : t('auth.signup_button'))
                }
              </button>
            </form>

            {/* OAuth separator */}
            <div className="flex items-center gap-3 my-1">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">{t('auth.or_continue_with')}</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* OAuth buttons */}
            <div className="flex gap-2">
              <button
                onClick={() => handleOAuth('google')}
                className="flex-1 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted transition-colors flex items-center justify-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                {t('auth.google')}
              </button>
              <button
                onClick={() => handleOAuth('github')}
                className="flex-1 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted transition-colors flex items-center justify-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                {t('auth.github')}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
