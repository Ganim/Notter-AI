-- supabase/migrations/2026-05-09-plan-model.sql

-- plans
create table plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled plan',
  working_content text not null default '',
  current_snapshot_id uuid, -- FK added after plan_versions exists
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plans_user_id_idx on plans(user_id);

-- plan_versions (append-only)
-- user_id is DENORMALIZED from plans.user_id — set by trigger on insert,
-- never updated. Avoids correlated-subquery RLS perf hit at scale.
create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content_markdown text not null,
  parent_version_id uuid references plan_versions(id) on delete set null,
  source text not null check (source in ('user', 'ai', 'import')),
  source_actor text,           -- 'claude-code' | 'codex' | null
  label text,                  -- optional human-readable name
  created_at timestamptz not null default now()
);
create index plan_versions_plan_id_idx on plan_versions(plan_id);
create index plan_versions_user_id_idx on plan_versions(user_id);

alter table plans
  add constraint plans_current_snapshot_fk
  foreign key (current_snapshot_id) references plan_versions(id) on delete set null;

-- plan_comments
-- user_id is DENORMALIZED plan owner (NOT necessarily comment author).
-- In Phase 1, author = owner always (no sharing). Phase 3 will revisit.
create table plan_comments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  version_id uuid not null references plan_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plan_comments_version_id_idx on plan_comments(version_id);
create index plan_comments_user_id_idx on plan_comments(user_id);

-- RLS: simple ownership check, no correlated subqueries.
alter table plans          enable row level security;
alter table plan_versions  enable row level security;
alter table plan_comments  enable row level security;

create policy "plans_user_isolation"    on plans         for all using (auth.uid() = user_id);
create policy "versions_user_isolation" on plan_versions for all using (auth.uid() = user_id);
create policy "comments_user_isolation" on plan_comments for all using (auth.uid() = user_id);

-- Trigger to denormalize user_id from plans → plan_versions / plan_comments on insert.
-- Keeps clients from having to compute it; prevents data drift.
create function set_plan_owner_id() returns trigger as $$
begin
  select user_id into new.user_id from plans where id = new.plan_id;
  if new.user_id is null then
    raise exception 'plan_id % not found', new.plan_id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger set_user_id_on_plan_versions
  before insert on plan_versions
  for each row execute function set_plan_owner_id();

create trigger set_user_id_on_plan_comments
  before insert on plan_comments
  for each row execute function set_plan_owner_id();
