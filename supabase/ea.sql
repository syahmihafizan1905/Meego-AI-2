-- MEEGO AI MT5 EA: one private key per member (created by /ea in the bot)
alter table public.telegram_users add column if not exists ea_key text;
create unique index if not exists telegram_users_ea_key on public.telegram_users (ea_key) where ea_key is not null;
