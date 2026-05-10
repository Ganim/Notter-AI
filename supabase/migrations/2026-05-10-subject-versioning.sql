-- supabase/migrations/2026-05-10-subject-versioning.sql
--
-- Supersedes 2026-05-09-plan-model.sql. The plans/plan_versions/plan_comments
-- tables are dropped because subjects are now the canonical plan entity.
-- Versions and comments anchor directly to subjects via a new subjects.id uuid.

-- 1. Drop the M2 plan schema (no real data yet — only Phase A acceptance test rows, if any).
drop table if exists plan_comments cascade;
drop table if exists plan_versions cascade;
drop table if exists plans          cascade;
drop function if exists set_plan_owner_id() cascade;

-- 2. Add a stable id to subjects. Existing rows get a generated uuid via DEFAULT.
--    Composite (user_id, project_name, file_name) PK stays — it is the
--    human-meaningful key. id is just a stable handle for FKs.
alter table subjects
  add column id uuid not null default gen_random_uuid();
alter table subjects
  add constraint subjects_id_unique unique (id);

-- 3. subject_versions (append-only). user_id denormalized via trigger.
create table subject_versions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content_markdown text not null,
  parent_version_id uuid references subject_versions(id) on delete set null,
  source text not null check (source in ('user', 'ai', 'import')),
  source_actor text,                           -- 'claude-code' | 'codex' | null
  label text,
  created_at timestamptz not null default now()
);
create index subject_versions_subject_id_idx on subject_versions(subject_id);
create index subject_versions_user_id_idx    on subject_versions(user_id);

-- 4. Add current_version_id to subjects (FK after subject_versions exists).
alter table subjects add column current_version_id uuid;
alter table subjects
  add constraint subjects_current_version_fk
  foreign key (current_version_id) references subject_versions(id) on delete set null;

-- 5. subject_comments. user_id = subject owner (denormalized). Author tracked separately.
create table subject_comments (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  version_id uuid not null references subject_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subject_comments_version_id_idx on subject_comments(version_id);
create index subject_comments_subject_id_idx on subject_comments(subject_id);
create index subject_comments_user_id_idx    on subject_comments(user_id);

-- 6. RLS — simple ownership.
alter table subject_versions enable row level security;
alter table subject_comments enable row level security;

create policy "subject_versions_user_isolation" on subject_versions for all
  using (auth.uid() = user_id);
create policy "subject_comments_user_isolation" on subject_comments for all
  using (auth.uid() = user_id);

-- 7. Trigger: denormalize user_id from subjects on insert.
create function set_subject_owner_id() returns trigger as $$
begin
  select user_id into new.user_id from subjects where id = new.subject_id;
  if new.user_id is null then
    raise exception 'subject_id % not found', new.subject_id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger set_user_id_on_subject_versions
  before insert on subject_versions
  for each row execute function set_subject_owner_id();

create trigger set_user_id_on_subject_comments
  before insert on subject_comments
  for each row execute function set_subject_owner_id();

-- 8. Realtime publication — explicit add so postgres_changes events fire.
alter publication supabase_realtime add table subject_versions;
alter publication supabase_realtime add table subject_comments;
