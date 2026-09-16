-- 出撃共有ボード用（Supabase SQL Editor で実行）
create table if not exists public.sortie_board (
  id int primary key default 1 check (id = 1),
  payload jsonb not null default '{"sorties":[],"members":[],"updatedAt":0}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.sortie_board (id, payload)
values (1, '{"sorties":[],"members":[],"updatedAt":0}'::jsonb)
on conflict (id) do nothing;

-- サーバの service_role だけで触る想定。anon は拒否
alter table public.sortie_board enable row level security;

drop policy if exists "sortie_board_deny_anon" on public.sortie_board;
-- service_role は RLS をバイパスするため、追加ポリシーは不要
