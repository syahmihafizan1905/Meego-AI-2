-- MEEGO AI Telegram bot: run once in Supabase → SQL Editor (after schema.sql).
-- If your telegram function's URL ends in something other than /telegram, change it in step 3.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- 1) Telegram chats and their link to a MEEGO account
create table if not exists public.telegram_users (
  chat_id bigint primary key,
  user_id uuid unique references auth.users(id) on delete set null,
  username text,
  first_name text,
  linked_at timestamptz,
  created_at timestamptz not null default now()
);
-- one-time codes the website creates for "Connect Telegram"
create table if not exists public.telegram_codes (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- server-only settings (no policies: only the server functions read it)
create table if not exists public.app_settings (key text primary key, value text not null);

alter table public.telegram_users enable row level security;
alter table public.telegram_codes enable row level security;
alter table public.app_settings   enable row level security;

drop policy if exists "telegram_users: own or admin" on public.telegram_users;
create policy "telegram_users: own or admin" on public.telegram_users for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "telegram_codes: create own" on public.telegram_codes;
create policy "telegram_codes: create own" on public.telegram_codes for insert with check (user_id = auth.uid());

-- 2) A random secret shared by the database and the bot
insert into public.app_settings (key, value)
values ('telegram_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- 3) Where the bot lives (change "telegram" if your function URL ends differently)
insert into public.app_settings (key, value)
values ('telegram_url', 'https://euoqlrwlzxzszgzqhakv.supabase.co/functions/v1/telegram')
on conflict (key) do update set value = excluded.value;

-- 4) Tell the bot about new signals, Hit TP/SL and announcements
create or replace function public.notify_telegram() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare u text; s text;
begin
  select value into u from public.app_settings where key = 'telegram_url';
  select value into s from public.app_settings where key = 'telegram_secret';
  if u is null or s is null then return new; end if;
  perform net.http_post(
    url := u,
    body := jsonb_build_object('event', TG_TABLE_NAME, 'op', TG_OP, 'record', to_jsonb(new),
                               'old', case when TG_OP = 'UPDATE' then to_jsonb(old) else null end),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-meego-secret', s)
  );
  return new;
end $$;

drop trigger if exists signals_to_telegram on public.signals;
create trigger signals_to_telegram after insert or update on public.signals
  for each row execute function public.notify_telegram();
drop trigger if exists mail_to_telegram on public.mail;
create trigger mail_to_telegram after insert on public.mail
  for each row execute function public.notify_telegram();

-- 5) Daily plan reminders at 09:00 Malaysia time (01:00 UTC)
do $$ begin perform cron.unschedule('meego-daily'); exception when others then null; end $$;
select cron.schedule('meego-daily', '0 1 * * *', $cron$
  select net.http_post(
    url := (select value from public.app_settings where key = 'telegram_url'),
    body := '{"event":"daily"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-meego-secret', (select value from public.app_settings where key = 'telegram_secret'))
  );
$cron$);
