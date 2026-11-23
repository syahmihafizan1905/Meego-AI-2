-- MEEGO AI: signal messages the bot keeps updating with live pips (server only, no policies).
create table if not exists public.tg_live (
  chat_id bigint not null,
  message_id bigint not null,
  signal_id text not null,
  title text not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);
alter table public.tg_live enable row level security;
