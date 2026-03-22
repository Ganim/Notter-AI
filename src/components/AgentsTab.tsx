import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentsStore } from '@/stores/agents-store';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Plus, Trash2 } from 'lucide-react';
import type { AIProvider } from '@/types';

export function AgentsTab() {
  const { t } = useTranslation();
  const {
    profiles, selectedProfileId,
    setSelectedProfileId, loadProfiles, createProfile, updateProfile, deleteProfile,
  } = useAgentsStore();

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  return (
    <div className="flex h-full w-full">
      {/* Sidebar: Profiles */}
      <div className="w-[30%] min-w-[250px] bg-muted/10 border-r flex flex-col">
        <div className="h-12 border-b flex justify-between items-center px-4 shrink-0 bg-background/50 sticky top-0 z-10">
          <h2 className="font-semibold text-sm">{t('agents.profiles')}</h2>
          <button onClick={createProfile} className="p-1 hover:bg-muted rounded text-muted-foreground transition-colors">
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {profiles.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedProfileId(p.id)}
              className={`p-3 rounded-md border text-sm cursor-pointer transition-colors flex justify-between items-center group ${selectedProfileId === p.id ? 'bg-primary/10 border-primary/50 text-primary font-medium shadow-sm' : 'bg-background hover:bg-muted'}`}
            >
              <span>{p.name}</span>
              {profiles.length > 1 && (
                <button onClick={(e) => { e.stopPropagation(); deleteProfile(p.id); }} className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive hover:text-destructive-foreground rounded transition-all text-muted-foreground">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Form: Edit Profile */}
      <div className="flex-1 flex flex-col bg-background overflow-y-auto">
        {selectedProfile ? (
          <div className="p-8 max-w-4xl mx-auto w-full flex flex-col gap-8">
            <div>
              <h1 className="text-2xl font-bold mb-2">{t('agents.config_title')}</h1>
              <p className="text-muted-foreground text-sm">{t('agents.config_desc')}</p>
            </div>

            <div className="grid gap-6">
              <div className="flex flex-col gap-2">
                <Label>{t('agents.agent_name')}</Label>
                <input type="text" value={selectedProfile.name} onChange={(e) => updateProfile(selectedProfile.id, { name: e.target.value })} className="bg-muted/50 border border-border px-3 py-2 rounded-md font-medium outline-none focus:ring-1 focus:ring-ring focus:bg-background transition-colors" />
              </div>

              <div className="flex flex-col gap-2">
                <Label>{t('agents.provider')}</Label>
                <Select value={selectedProfile.provider} onValueChange={(val: string | null) => { if (val) updateProfile(selectedProfile.id, { provider: val as AIProvider }); }}>
                  <SelectTrigger className="w-[300px] bg-background">
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

              {selectedProfile.provider !== 'ollama' && (
                <div className="flex flex-col gap-2">
                  <Label>{t('agents.api_key', { provider: selectedProfile.provider.toUpperCase() })}</Label>
                  <input type="password" placeholder={t('agents.api_key_placeholder', { provider: selectedProfile.provider })} value={selectedProfile.apiKey} onChange={(e) => updateProfile(selectedProfile.id, { apiKey: e.target.value })} className="bg-muted/50 border border-border px-3 py-2 rounded-md font-mono text-sm outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}

              <div className="flex flex-col gap-3 p-4 border border-border/70 rounded-md bg-muted/20">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <Label className="font-semibold text-base text-foreground">{t('agents.autonomous_mode')}</Label>
                    <span className="text-xs text-muted-foreground max-w-lg leading-relaxed">{t('agents.autonomous_desc')}</span>
                  </div>
                  <Switch checked={selectedProfile.autonomous} onCheckedChange={(val: boolean) => updateProfile(selectedProfile.id, { autonomous: val })} />
                </div>
              </div>

              <div className="flex flex-col gap-2 flex-1">
                <Label>{t('agents.system_prompt')}</Label>
                <textarea
                  value={selectedProfile.systemPrompt}
                  onChange={(e) => updateProfile(selectedProfile.id, { systemPrompt: e.target.value })}
                  className="w-full min-h-[300px] max-h-screen bg-background border border-border p-4 rounded-md font-mono text-sm leading-relaxed outline-none focus:ring-1 focus:ring-ring resize-y"
                  placeholder={t('agents.system_prompt_placeholder')}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm flex-col gap-4">
            <p>{t('agents.no_profile')}</p>
            <button onClick={createProfile} className="text-primary hover:underline">{t('agents.select_or_create')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
