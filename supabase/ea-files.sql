-- MEEGO AI EA files (compiled .ex5 and source .mq5), base64. Row level security on with no policy: only the bot can read them.
create table if not exists public.ea_files (
  name text primary key,
  b64 text not null,
  updated_at timestamptz not null default now()
);
alter table public.ea_files enable row level security;
