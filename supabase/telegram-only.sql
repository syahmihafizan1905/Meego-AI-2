-- MEEGO AI: Telegram-only plans. Run once in Supabase -> SQL Editor (after telegram.sql).
alter table public.telegram_users add column if not exists is_admin boolean not null default false;
alter table public.telegram_users add column if not exists tier text;
alter table public.telegram_users add column if not exists plan_end date;
create table if not exists public.tg_ai_usage (chat_id bigint not null, day date not null default current_date, count int not null default 0, primary key (chat_id, day));
alter table public.tg_ai_usage enable row level security;
-- If the owner already linked Telegram from the website, make that chat the admin.
update public.telegram_users set is_admin = true where user_id in (select id from public.profiles where role = 'owner');

-- Private mode + add customers by @username with buttons
create table if not exists public.tg_pending (ref text primary key, tier text not null, days int not null default 30, created_at timestamptz not null default now());
alter table public.tg_pending enable row level security;
create table if not exists public.tg_state (chat_id bigint primary key, step text, updated_at timestamptz not null default now());
alter table public.tg_state enable row level security;
