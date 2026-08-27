create extension if not exists pgcrypto;

create table if not exists public.research_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  track_key text not null,
  isrc text,
  mbid text,
  title text not null,
  artist text not null,
  release_date date,
  album text,
  genres text[] not null default '{}',
  source_note text,
  raw_analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, track_key)
);

create table if not exists public.research_credits (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.research_tracks(id) on delete cascade,
  creator_key text not null,
  name text not null,
  role text not null,
  external_ipi text,
  external_mbid text,
  created_at timestamptz not null default now(),
  unique (track_id, creator_key, role)
);

create table if not exists public.creator_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  creator_key text not null,
  name text not null,
  roles text[] not null default '{}',
  scanned_works integer not null default 0,
  confidence text not null default 'limited' check (confidence in ('verified', 'limited')),
  status text not null default 'complete' check (status in ('complete')),
  profile jsonb not null,
  completed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, creator_key)
);

create index if not exists research_tracks_user_created_idx on public.research_tracks(user_id, created_at desc);
create index if not exists research_credits_track_idx on public.research_credits(track_id);
create index if not exists research_credits_creator_idx on public.research_credits(creator_key);
create index if not exists creator_profiles_user_updated_idx on public.creator_profiles(user_id, updated_at desc);
create index if not exists creator_profiles_creator_idx on public.creator_profiles(creator_key);

alter table public.research_tracks enable row level security;
alter table public.research_credits enable row level security;
alter table public.creator_profiles enable row level security;

drop policy if exists "users manage own tracks" on public.research_tracks;
create policy "users manage own tracks" on public.research_tracks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users read own credits" on public.research_credits;
create policy "users read own credits" on public.research_credits for select using (exists (select 1 from public.research_tracks track where track.id = track_id and track.user_id = auth.uid()));
drop policy if exists "users insert own credits" on public.research_credits;
create policy "users insert own credits" on public.research_credits for insert with check (exists (select 1 from public.research_tracks track where track.id = track_id and track.user_id = auth.uid()));
drop policy if exists "users update own credits" on public.research_credits;
create policy "users update own credits" on public.research_credits for update using (exists (select 1 from public.research_tracks track where track.id = track_id and track.user_id = auth.uid()));
drop policy if exists "users delete own credits" on public.research_credits;
create policy "users delete own credits" on public.research_credits for delete using (exists (select 1 from public.research_tracks track where track.id = track_id and track.user_id = auth.uid()));

drop policy if exists "users manage own creator profiles" on public.creator_profiles;
create policy "users manage own creator profiles" on public.creator_profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
