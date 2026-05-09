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

-- Projects metadata (N rows per user)
CREATE TABLE projects (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, name),
  UNIQUE (user_id, id)
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own projects" ON projects FOR ALL USING (auth.uid() = user_id);

-- Subjects / notes (markdown content per project)
CREATE TABLE subjects (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, project_name, file_name)
);

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own subjects" ON subjects FOR ALL USING (auth.uid() = user_id);

-- Board tasks (N rows per user)
CREATE TABLE board_tasks (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  subject_name TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);

ALTER TABLE board_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own board_tasks" ON board_tasks FOR ALL USING (auth.uid() = user_id);

-- Actions (stored as JSONB due to complex nested structure)
CREATE TABLE actions (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own actions" ON actions FOR ALL USING (auth.uid() = user_id);
