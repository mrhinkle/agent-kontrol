-- Owner discovery (#66). Changelog only. The same statements are in schema.sql.
-- Additive: new table, new nullable-or-defaulted columns. No existing column changes.

create table if not exists watched_owners (
  owner text primary key,
  activity_days integer not null default 30,
  include_forks boolean not null default false,
  include_archived boolean not null default false,
  last_error text,
  last_error_at timestamptz,
  last_discovered_at timestamptz,
  actor_type text,
  actor_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table watched_repos add column if not exists origin text not null default 'manual';
alter table watched_repos add column if not exists pinned boolean not null default false;
alter table watched_repos add column if not exists hidden boolean not null default false;
alter table watched_repos add column if not exists gone boolean not null default false;
alter table watched_repos add column if not exists is_fork boolean not null default false;
alter table watched_repos add column if not exists is_archived boolean not null default false;
alter table watched_repos add column if not exists last_activity_at timestamptz;

-- Deferrable so replaceWatchedRepos can swap two short names in one statement.
-- Checked at the end of that statement (initially immediate). Discovery retries
-- a 23505 once, then the route answers 409.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'watched_repos_short_key'
      and conrelid = 'watched_repos'::regclass
  ) then
    alter table watched_repos
      add constraint watched_repos_short_key
      unique (short)
      deferrable initially immediate;
  end if;
end $$;
