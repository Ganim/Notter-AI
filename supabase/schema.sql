-- User preferences (1 row per user)
CREATE TABLE user_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  dark_mode BOOLEAN DEFAULT true,
  language TEXT DEFAULT 'en',
  terminal_theme TEXT DEFAULT 'Default',
  terminal_font TEXT DEFAULT '''Cascadia Code'', monospace',
  terminal_font_size INT DEFAULT 13,
  terminal_ligatures BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Agent profiles (N rows per user)
CREATE TABLE agent_profiles (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  autonomous BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

-- RLS policies
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own preferences" ON user_preferences FOR ALL USING (auth.uid() = user_id);

ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own profiles" ON agent_profiles FOR ALL USING (auth.uid() = user_id);
