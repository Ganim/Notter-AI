import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentsStore } from '@/stores/agents-store';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, Send, Eraser, Loader2 } from 'lucide-react';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import type { AIProvider } from '@/types';

export function AgentsTab() {
  const { t } = useTranslation();
  const width = useWindowWidth();
  const compact = width < 900;

  const {
    profiles, selectedProfileId,
    setSelectedProfileId, loadProfiles, createProfile, updateProfile, deleteProfile,
    ollamaModels, ollamaModelsLoading, ollamaModelsError, loadOllamaModels, getModelsForProvider,
    chatMessages, chatLoading, sendTestMessage, clearChat,
  } = useAgentsStore();

  useEffect(() => {
    loadProfiles();
    loadOllamaModels();
  }, [loadProfiles, loadOllamaModels]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const currentChatMessages = selectedProfileId ? (chatMessages[selectedProfileId] || []) : [];
  const models = selectedProfile ? getModelsForProvider(selectedProfile.provider) : [];

  const handleProviderChange = (val: string | null) => {
    if (!val || !selectedProfile) return;
    updateProfile(selectedProfile.id, { provider: val as AIProvider, model: '' });
    if (val === 'ollama' && ollamaModels.length === 0) loadOllamaModels();
  };

  return (
    <div className={`flex h-full w-full ${compact ? 'flex-col' : ''}`}>
      {/* Sidebar: Profiles */}
      <div className={`${compact ? 'h-[200px] border-b' : 'w-[250px] min-w-[200px] border-r'} bg-muted/10 flex flex-col`}>
        <div className="h-12 border-b flex justify-between items-center px-4 shrink-0 bg-background/50 sticky top-0 z-10">
          <h2 className="font-semibold text-sm">{t('agents.profiles')}</h2>
          <button onClick={createProfile} className="p-1 hover:bg-muted rounded text-muted-foreground transition-colors">
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
          {profiles.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedProfileId(p.id)}
              className={`p-2.5 rounded-md border text-sm cursor-pointer transition-colors flex justify-between items-center group ${selectedProfileId === p.id ? 'bg-primary/10 border-primary/50 text-primary font-medium shadow-sm' : 'bg-background hover:bg-muted'}`}
            >
              <span className="truncate">{p.name}</span>
              {profiles.length > 1 && (
                <button onClick={(e) => { e.stopPropagation(); deleteProfile(p.id); }} className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive hover:text-destructive-foreground rounded transition-all text-muted-foreground shrink-0">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {selectedProfile ? (
        <div className={`flex-1 flex ${compact ? 'flex-col' : ''} overflow-hidden`}>
          {/* Config panel */}
          <div className={`${compact ? '' : 'w-1/2 border-r'} overflow-y-auto`}>
            <div className="p-6 flex flex-col gap-6 max-w-2xl">
              <div>
                <h1 className="text-xl font-bold mb-1">{t('agents.config_title')}</h1>
                <p className="text-muted-foreground text-xs">{t('agents.config_desc')}</p>
              </div>

              <div className="grid gap-5">
                <div className="flex flex-col gap-1.5">
                  <Label>{t('agents.agent_name')}</Label>
                  <input type="text" value={selectedProfile.name} onChange={(e) => updateProfile(selectedProfile.id, { name: e.target.value })} className="bg-muted/50 border border-border px-3 py-2 rounded-md font-medium outline-none focus:ring-1 focus:ring-ring focus:bg-background transition-colors" />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('agents.provider')}</Label>
                  <Select value={selectedProfile.provider} onValueChange={handleProviderChange}>
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder={t('agents.select_provider')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ollama">{t('agents.provider_ollama')}</SelectItem>
                      <SelectItem value="openai">{t('agents.provider_openai')}</SelectItem>
                      <SelectItem value="anthropic">{t('agents.provider_anthropic')}</SelectItem>
                      <SelectItem value="gemini">{t('agents.provider_gemini')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('agents.model')}</Label>
                  {selectedProfile.provider === 'ollama' && ollamaModelsLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 size={14} className="animate-spin" /> {t('agents.status_loading')}
                    </div>
                  ) : selectedProfile.provider === 'ollama' && ollamaModelsError ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-xs text-destructive">{t('agents.fetch_models_error')}</p>
                      <input type="text" value={selectedProfile.model} onChange={(e) => updateProfile(selectedProfile.id, { model: e.target.value })} placeholder="llama3.2" className="bg-muted/50 border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring" />
                    </div>
                  ) : models.length > 0 ? (
                    <Select value={selectedProfile.model || ''} onValueChange={(val: string | null) => { if (val) updateProfile(selectedProfile.id, { model: val }); }}>
                      <SelectTrigger className="w-full bg-background">
                        <SelectValue placeholder={t('agents.select_model')} />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <input type="text" value={selectedProfile.model} onChange={(e) => updateProfile(selectedProfile.id, { model: e.target.value })} placeholder={selectedProfile.provider === 'ollama' ? 'llama3.2' : 'model-name'} className="bg-muted/50 border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring" />
                  )}
                </div>

                {selectedProfile.provider !== 'ollama' && (
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('agents.api_key', { provider: selectedProfile.provider.toUpperCase() })}</Label>
                    <input type="password" placeholder={t('agents.api_key_placeholder', { provider: selectedProfile.provider })} value={selectedProfile.apiKey} onChange={(e) => updateProfile(selectedProfile.id, { apiKey: e.target.value })} className="bg-muted/50 border border-border px-3 py-2 rounded-md font-mono text-sm outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <Label>{t('agents.system_prompt')}</Label>
                  <textarea
                    value={selectedProfile.systemPrompt}
                    onChange={(e) => updateProfile(selectedProfile.id, { systemPrompt: e.target.value })}
                    className="w-full min-h-[180px] bg-background border border-border p-3 rounded-md font-mono text-sm leading-relaxed outline-none focus:ring-1 focus:ring-ring resize-y"
                    placeholder={t('agents.system_prompt_placeholder')}
                  />
                </div>

                <div className="flex items-center justify-between p-3 border border-border/70 rounded-md bg-muted/20">
                  <div className="flex flex-col gap-0.5">
                    <Label className="font-semibold text-sm text-foreground">{t('agents.autonomous_mode')}</Label>
                    <span className="text-xs text-muted-foreground max-w-lg leading-relaxed">{t('agents.autonomous_desc')}</span>
                  </div>
                  <Switch checked={selectedProfile.autonomous} onCheckedChange={(val: boolean) => updateProfile(selectedProfile.id, { autonomous: val })} />
                </div>
              </div>
            </div>
          </div>

          {/* Test Chat panel */}
          <TestChatPanel
            profileId={selectedProfile.id}
            messages={currentChatMessages}
            loading={chatLoading}
            onSend={sendTestMessage}
            onClear={() => clearChat(selectedProfile.id)}
            t={t}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm flex-col gap-4">
          <p>{t('agents.no_profile')}</p>
          <button onClick={createProfile} className="text-primary hover:underline">{t('agents.select_or_create')}</button>
        </div>
      )}
    </div>
  );
}

function TestChatPanel({
  profileId, messages, loading, onSend, onClear, t,
}: {
  profileId: string;
  messages: { role: string; content: string }[];
  loading: boolean;
  onSend: (content: string) => Promise<void>;
  onClear: () => void;
  t: (key: string) => string;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, loading]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput('');
    onSend(trimmed);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="h-12 border-b flex justify-between items-center px-4 shrink-0 bg-background/50">
        <h2 className="font-semibold text-sm">{t('agents.test_chat')}</h2>
        <button onClick={onClear} className="p-1 hover:bg-muted rounded text-muted-foreground transition-colors" title={t('agents.chat_clear')}>
          <Eraser size={16} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.length === 0 && !loading && (
          <p className="text-muted-foreground text-sm text-center mt-8">{t('agents.chat_empty')}</p>
        )}
        {messages.map((msg, i) => (
          <div key={`${profileId}-${i}`} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : msg.content.startsWith('Error:')
                  ? 'bg-destructive/10 text-destructive border border-destructive/30'
                  : 'bg-muted'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2 text-sm flex items-center gap-2 text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> {t('agents.status_loading')}
            </div>
          </div>
        )}
      </div>

      <div className="border-t p-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={t('agents.chat_placeholder')}
          disabled={loading}
          className="flex-1 bg-muted/50 border border-border px-3 py-2 rounded-md text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
