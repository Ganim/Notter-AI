export type AIProvider = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface AgentProfile {
  id: string;
  name: string;
  provider: AIProvider;
  apiKey: string;
  systemPrompt: string;
  autonomous: boolean;
}

export interface Project {
  name: string;
  path: string;
}

export type ShellType = 'powershell' | 'bash' | 'cmd';

export interface ConsoleInstance {
  id: string;
  name: string;
  cwd?: string;
  shell?: ShellType;
}

export interface EditorTheme {
  name: string;
  value: string;
  light: { hex: string; base: 'vs' | 'vs-dark' };
  dark: { hex: string; base: 'vs' | 'vs-dark' };
}
