export type AIProvider = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface AgentProfile {
  id: string;
  name: string;
  provider: AIProvider;
  apiKey: string;
  systemPrompt: string;
  autonomous: boolean;
}

export interface ConsoleInstance {
  id: string;
  name: string;
}

export interface EditorTheme {
  name: string;
  value: string;
  light: { hex: string; base: 'vs' | 'vs-dark' };
  dark: { hex: string; base: 'vs' | 'vs-dark' };
}
