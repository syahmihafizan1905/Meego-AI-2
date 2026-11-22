-- MEEGO AI database: run this once in Supabase → SQL Editor → New query → Run.
-- Tables keep each record as JSON in `data`, which is what the app reads and writes.

-- 1) Profiles: one row per signed-up user (filled automatically on sign-up)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) App tables (id + JSON data)
create table if not exists public.signals   (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.mail      (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.customers (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.members   (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
-- price cache used by the `candles` function (server only)
create table if not exists public.price_cache (key text primary key, data jsonb not null, fetched_at timestamptz not null default now());
-- AI usage counter used by the `ai` function (server only)
create table if not exists public.ai_usage (user_id uuid not null, day date not null default current_date, count int not null default 0, primary key (user_id, day));

-- 3) Helper checks
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('owner','admin'));
$$;

create or replace function public.member_tier() returns text
language sql stable security definer set search_path = public as $$
  select case
    when (data->>'end') is not null and (data->>'end') <> '' and (data->>'end')::date < current_date then null
    else data->>'tier' end
  from public.members where id = auth.uid()::text;
$$;

-- 4) Row level security: who can read and write what
alter table public.profiles    enable row level security;
alter table public.signals     enable row level security;
alter table public.mail        enable row level security;
alter table public.customers   enable row level security;
alter table public.members     enable row level security;
alter table public.price_cache enable row level security;
alter table public.ai_usage    enable row level security;

drop policy if exists "profiles: own or admin read" on public.profiles;
create policy "profiles: own or admin read" on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles: admin update" on public.profiles;
create policy "profiles: admin update" on public.profiles for update using (public.is_admin());

-- Signals: admins see all; active members see intraday; only Ultimate sees Swing
drop policy if exists "signals: read by plan" on public.signals;
create policy "signals: read by plan" on public.signals for select using (
  public.is_admin()
  or (public.member_tier() is not null and (data->>'kind' <> 'Swing' or public.member_tier() = 'Ultimate'))
);
drop policy if exists "signals: admin write" on public.signals;
create policy "signals: admin write" on public.signals for all using (public.is_admin()) with check (public.is_admin());

-- Mailbox: admins and active members read; admins write
drop policy if exists "mail: read" on public.mail;
create policy "mail: read" on public.mail for select using (public.is_admin() or public.member_tier() is not null);
drop policy if exists "mail: admin write" on public.mail;
create policy "mail: admin write" on public.mail for all using (public.is_admin()) with check (public.is_admin());

-- Customers: admins only
drop policy if exists "customers: admin" on public.customers;
create policy "customers: admin" on public.customers for all using (public.is_admin()) with check (public.is_admin());

-- Members (plan per user): admins manage; each user reads their own row
drop policy if exists "members: own read" on public.members;
create policy "members: own read" on public.members for select using (id = auth.uid()::text or public.is_admin());
drop policy if exists "members: admin write" on public.members;
create policy "members: admin write" on public.members for all using (public.is_admin()) with check (public.is_admin());
-- price_cache and ai_usage have no policies: only the server functions (service role) touch them.

-- 5) Live updates in the app
do $$ begin
  begin alter publication supabase_realtime add table public.signals;   exception when others then null; end;
  begin alter publication supabase_realtime add table public.mail;      exception when others then null; end;
  begin alter publication supabase_realtime add table public.customers; exception when others then null; end;
  begin alter publication supabase_realtime add table public.members;   exception when others then null; end;
end $$;

-- 6) AFTER you sign up on the website, make yourself the owner (replace the email):
-- update public.profiles set role = 'owner' where email = 'your-email@example.com';
