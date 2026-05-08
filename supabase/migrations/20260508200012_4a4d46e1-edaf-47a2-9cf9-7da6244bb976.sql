
alter table public.symbols
  drop column if exists position_size_mode,
  drop column if exists position_size_value;

drop type if exists public.position_size_mode;

alter table public.symbols
  add column account_balance_percent numeric not null default 5,
  add column position_size_multiplier numeric not null default 1.0;

alter table public.symbols alter column leverage set default 10;

alter table public.symbols
  add constraint symbols_balance_pct_range
    check (account_balance_percent >= 0.1 and account_balance_percent <= 100),
  add constraint symbols_multiplier_range
    check (position_size_multiplier >= 0.1 and position_size_multiplier <= 3.0),
  add constraint symbols_leverage_range
    check (leverage >= 1 and leverage <= 125);
