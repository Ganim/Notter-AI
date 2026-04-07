import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2 } from 'lucide-react';
import { useAiStore } from '@/stores/ai-store';
import { generateText } from '@/lib/ai-client';

type State = 'idle' | 'generating' | 'loading-model' | 'received' | 'error';

export function TestConnection() {
  const { t } = useTranslation();
  const activeTag = useAiStore((s) => s.activeModelTag);
  const activeProviderId = useAiStore((s) => s.activeProviderId);
  const cloudConfigs = useAiStore((s) => s.cloudConfigs);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [state, setState] = useState<State>('idle');

  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  // Clean up any pending timers / cancel pending response if unmounted
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    };
  }, []);

  const disabled =
    activeProviderId === 'ollama'
      ? !activeTag
      : !cloudConfigs[activeProviderId].apiKey.trim();

  function clearTimers() {
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  }

  async function handleSend() {
    if (disabled || !prompt.trim()) return;
    setState('generating');
    setResponse('');

    // Each send gets its own "request id" so a stale response from a
    // previous click never overwrites a newer state.
    const myRequestId = Symbol('req');
    (handleSend as unknown as { current?: symbol }).current = myRequestId;
    cancelledRef.current = false;

    slowTimerRef.current = setTimeout(() => {
      if (cancelledRef.current) return;
      setState((s) => (s === 'generating' ? 'loading-model' : s));
    }, 3000);

    timeoutTimerRef.current = setTimeout(() => {
      if (cancelledRef.current) return;
      cancelledRef.current = true;
      setState('error');
      setResponse(t('manage_ai.error_pull', { error: 'timeout (90s)' }));
    }, 90000);

    try {
      let model: string;
      let apiKey: string | undefined;
      if (activeProviderId === 'ollama') {
        model = activeTag!;
      } else {
        const cfg = cloudConfigs[activeProviderId];
        model = cfg.model;
        apiKey = cfg.apiKey;
      }
      const out = await generateText({ providerId: activeProviderId, model, apiKey, prompt });
      // Drop the response if we were cancelled or replaced by a newer click
      if (
        cancelledRef.current ||
        (handleSend as unknown as { current?: symbol }).current !== myRequestId
      ) {
        return;
      }
      setResponse(out);
      setState('received');
    } catch (e) {
      if (cancelledRef.current) return;
      setResponse((e as Error).message);
      setState('error');
    } finally {
      clearTimers();
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t('manage_ai.test_title')}</h3>
      {disabled ? (
        <p className="text-xs text-muted-foreground italic">{t('manage_ai.test_no_default')}</p>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
              placeholder={t('manage_ai.test_placeholder')}
              disabled={state === 'generating' || state === 'loading-model'}
              className="flex-1 h-8 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={
                !prompt.trim() || state === 'generating' || state === 'loading-model'
              }
              className="h-8 w-8 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {state === 'generating' || state === 'loading-model' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
            </button>
          </div>
          {state === 'loading-model' && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('manage_ai.test_loading_model')}
            </p>
          )}
          {state === 'generating' && (
            <p className="text-xs text-muted-foreground">{t('manage_ai.test_generating')}</p>
          )}
          {(state === 'received' || state === 'error') && response && (
            <div
              className={`rounded-md border p-2 text-xs whitespace-pre-wrap max-h-48 overflow-auto ${
                state === 'error'
                  ? 'border-destructive/40 bg-destructive/5 text-destructive'
                  : 'border-border bg-muted/30'
              }`}
            >
              {response}
            </div>
          )}
        </>
      )}
    </div>
  );
}
