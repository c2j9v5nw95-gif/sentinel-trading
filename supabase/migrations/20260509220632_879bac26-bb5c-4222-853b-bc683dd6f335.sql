create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('paper','live')),
  captured_at timestamptz not null default now(),
  total_equity numeric,
  available_balance numeric,
  unrealized_pnl numeric,
  realized_pnl numeric,
  used_margin numeric,
  account_mode text,
  raw jsonb,
  error text
);

create index balance_snapshots_source_captured_at_idx
  on public.balance_snapshots (source, captured_at desc);

alter table public.balance_snapshots enable row level security;

create policy "operator reads balance_snapshots"
  on public.balance_snapshots
  for select
  to authenticated
  using (has_role(auth.uid(), 'operator'::app_role));