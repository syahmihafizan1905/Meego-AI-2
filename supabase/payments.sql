-- MEEGO AI payments: customer picks a plan, transfers, sends the receipt; MEEGO AI checks it and the admin taps Approve.
create table if not exists public.tg_payments (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  tier text not null,
  amount numeric not null,
  days int not null,
  status text not null default 'waiting',  -- waiting (for receipt) | review (for admin) | approved | rejected
  file_id text,
  file_unique_id text,
  file_kind text,
  ref text,
  ai jsonb,
  checks jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tg_payments_chat on public.tg_payments (chat_id);
create index if not exists tg_payments_file on public.tg_payments (file_unique_id);
alter table public.tg_payments enable row level security;
