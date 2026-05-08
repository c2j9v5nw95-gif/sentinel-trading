
-- ============ ENUMS ============
create type public.app_role as enum ('operator');
create type public.transport_pref as enum ('webhook','email','either');
create type public.transport_kind as enum ('webhook','email');
create type public.signal_action as enum ('ENTER-LONG','ENTER-SHORT','EXIT-LONG','EXIT-SHORT','HEALTH');
create type public.signal_type as enum ('trade','stats');
create type public.signal_portion as enum ('full','tp1','rest');
create type public.signal_status as enum ('queued','processing','accepted','rejected','error');
create type public.exit_reason as enum ('tp1','tp2_rest','sl_failsafe','opposite','trend_fail');
create type public.entry_reason as enum ('long_entry','short_entry');
create type public.position_side as enum ('long','short');
create type public.protection_state as enum ('unprotected','sl_only','sl_and_tsl','closed');
create type public.order_purpose as enum ('entry','sl','tsl','tp1','tp2_rest','exit_full','manual_close');
create type public.order_status as enum ('submitted','filled','partial','cancelled','rejected','error');
create type public.alert_severity as enum ('info','warning','critical');
create type public.position_size_mode as enum ('fixed_usdt','pct_equity');
create type public.margin_mode as enum ('isolated','cross');
create type public.auth_status as enum ('ok','bad_secret','malformed');
create type public.risk_gate as enum ('health','risk','kill_switch','dedupe','unprotected_pause','transport_mismatch');
create type public.risk_outcome as enum ('pass','block');

-- ============ ROLES + has_role ============
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "operators read own roles" on public.user_roles
  for select to authenticated using (user_id = auth.uid());

-- ============ APP SETTINGS (single row) ============
create table public.app_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique,
  entries_paused boolean not null default false,
  emergency_stop boolean not null default false,
  email_ingest_enabled boolean not null default false,
  default_leverage numeric not null default 5,
  max_concurrent_positions int not null default 5,
  max_daily_loss_pct numeric not null default 5,
  dedupe_window_seconds int not null default 20,
  webhook_secret_version int not null default 1,
  webhook_secret_rotated_at timestamptz,
  webhook_secret_hint text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create policy "operator manages app_settings" on public.app_settings
  for all to authenticated
  using (has_role(auth.uid(),'operator'))
  with check (has_role(auth.uid(),'operator'));

insert into public.app_settings (singleton) values (true);

-- ============ SYMBOLS ============
create table public.symbols (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique,            -- normalized e.g. PIEVERSEUSDT
  display_symbol text,
  category text not null default 'linear',
  enabled boolean not null default true,
  preferred_transport transport_pref not null default 'webhook',

  position_size_mode position_size_mode not null default 'fixed_usdt',
  position_size_value numeric not null default 50,
  leverage numeric not null default 5,
  margin_mode margin_mode not null default 'isolated',

  sl_pct numeric not null default 1.5,
  tsl_enabled boolean not null default true,
  tsl_activation_profit_pct numeric not null default 1.0,
  tsl_callback_pct numeric not null default 0.5,

  tp2_enabled boolean not null default false,
  tp1_exit_percent numeric(5,2) not null default 100,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tp_exit_rule check (
    (tp2_enabled = false and tp1_exit_percent = 100)
    or (tp2_enabled = true and tp1_exit_percent > 0 and tp1_exit_percent < 100)
  )
);
alter table public.symbols enable row level security;
create policy "operator manages symbols" on public.symbols
  for all to authenticated
  using (has_role(auth.uid(),'operator')) with check (has_role(auth.uid(),'operator'));

-- ============ STRATEGIES ============
create table public.strategies (
  id uuid primary key default gen_random_uuid(),
  name text not null,        -- e.g. EL1, ES1, STRAT2
  tag  text not null default '',
  enabled boolean not null default true,
  health_min_winrate numeric,
  health_min_profit_factor numeric,
  health_min_net_profit numeric,
  last_health_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, tag)
);
alter table public.strategies enable row level security;
create policy "operator manages strategies" on public.strategies
  for all to authenticated
  using (has_role(auth.uid(),'operator')) with check (has_role(auth.uid(),'operator'));

-- ============ STRATEGY CODES (lookup) ============
create table public.strategy_codes (
  code text primary key,
  side position_side not null,
  kind text not null check (kind in ('entry','exit')),
  exit_reason exit_reason,
  entry_reason entry_reason,
  description text not null
);
alter table public.strategy_codes enable row level security;
create policy "operator reads strategy_codes" on public.strategy_codes
  for select to authenticated using (has_role(auth.uid(),'operator'));

insert into public.strategy_codes(code, side, kind, entry_reason, exit_reason, description) values
  ('EL1','long','entry','long_entry',null,'Long entry'),
  ('ES1','short','entry','short_entry',null,'Short entry'),
  ('XL1','long','exit',null,'tp1','Long TP1'),
  ('XL4','long','exit',null,'tp2_rest','Long TP2 / REST'),
  ('XL2','long','exit',null,'sl_failsafe','Long SL / failsafe'),
  ('XL3','long','exit',null,'opposite','Long opposite signal'),
  ('XL5','long','exit',null,'trend_fail','Long trend fail'),
  ('XS1','short','exit',null,'tp1','Short TP1'),
  ('XS4','short','exit',null,'tp2_rest','Short TP2 / REST'),
  ('XS2','short','exit',null,'sl_failsafe','Short SL / failsafe'),
  ('XS3','short','exit',null,'opposite','Short opposite signal'),
  ('XS5','short','exit',null,'trend_fail','Short trend fail');

-- ============ RAW ALERTS (audit) ============
create table public.raw_alerts (
  id uuid primary key default gen_random_uuid(),
  transport transport_kind not null,
  received_at timestamptz not null default now(),
  remote_ip text,
  headers jsonb,
  body_text text,
  auth_status auth_status not null,
  signal_id uuid,
  created_at timestamptz not null default now()
);
alter table public.raw_alerts enable row level security;
create policy "operator reads raw_alerts" on public.raw_alerts
  for select to authenticated using (has_role(auth.uid(),'operator'));

-- ============ SIGNALS ============
create table public.signals (
  id uuid primary key default gen_random_uuid(),
  transport transport_kind not null,
  type signal_type not null,
  action signal_action,
  symbol text,
  strategy text,
  tag text default '',
  strategy_code text,
  entry_reason entry_reason,
  exit_reason exit_reason,
  portion signal_portion not null default 'full',
  bar_time timestamptz,
  payload jsonb not null,
  dedupe_key text not null unique,
  status signal_status not null default 'queued',
  decision_reason text,
  processed_at timestamptz,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.signals enable row level security;
create policy "operator reads signals" on public.signals
  for select to authenticated using (has_role(auth.uid(),'operator'));
create index on public.signals (status, created_at);
create index on public.signals (symbol, created_at desc);

alter table public.raw_alerts add constraint raw_alerts_signal_fk
  foreign key (signal_id) references public.signals(id) on delete set null;

-- ============ HEALTH SNAPSHOTS ============
create table public.health_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  strategy text not null,
  tag text not null default '',
  net_profit numeric,
  winrate numeric,
  profit_factor numeric,
  bar_time timestamptz,
  source_signal_id uuid references public.signals(id) on delete set null,
  payload jsonb,
  created_at timestamptz not null default now()
);
alter table public.health_snapshots enable row level security;
create policy "operator reads health" on public.health_snapshots
  for select to authenticated using (has_role(auth.uid(),'operator'));
create index on public.health_snapshots (symbol, strategy, tag, created_at desc);

-- ============ RISK DECISIONS ============
create table public.risk_decisions (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.signals(id) on delete cascade,
  gate risk_gate not null,
  outcome risk_outcome not null,
  reason text,
  metrics jsonb,
  created_at timestamptz not null default now()
);
alter table public.risk_decisions enable row level security;
create policy "operator reads risk" on public.risk_decisions
  for select to authenticated using (has_role(auth.uid(),'operator'));
create index on public.risk_decisions (signal_id);

-- ============ POSITIONS ============
create table public.positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side position_side not null,
  entry_price numeric,
  qty_initial numeric,
  qty_open numeric,
  leverage numeric,
  protection_state protection_state not null default 'unprotected',
  sl_order_id text,
  sl_price numeric,
  tsl_order_id text,
  tsl_active boolean not null default false,
  tsl_activated_at timestamptz,
  tp1_done boolean not null default false,
  tp1_qty numeric,
  tp2_done boolean not null default false,
  entry_signal_id uuid references public.signals(id) on delete set null,
  last_exit_signal_id uuid references public.signals(id) on delete set null,
  unprotected_since timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.positions enable row level security;
create policy "operator reads positions" on public.positions
  for select to authenticated using (has_role(auth.uid(),'operator'));
create index on public.positions (symbol) where closed_at is null;

-- ============ ORDERS ============
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.signals(id) on delete set null,
  position_id uuid references public.positions(id) on delete set null,
  symbol text not null,
  side text not null,
  order_type text,
  qty numeric,
  price numeric,
  purpose order_purpose not null,
  bybit_order_id text,
  status order_status not null default 'submitted',
  error_message text,
  request_payload jsonb,
  response_payload jsonb,
  submitted_at timestamptz not null default now(),
  finalized_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.orders enable row level security;
create policy "operator reads orders" on public.orders
  for select to authenticated using (has_role(auth.uid(),'operator'));
create index on public.orders (symbol, submitted_at desc);

-- ============ POSITION EVENTS ============
create table public.position_events (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references public.positions(id) on delete cascade,
  event_type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.position_events enable row level security;
create policy "operator reads position_events" on public.position_events
  for select to authenticated using (has_role(auth.uid(),'operator'));

-- ============ AUDIT / ALERTS / ERRORS ============
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  target text,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
create policy "operator reads audit" on public.audit_log
  for select to authenticated using (has_role(auth.uid(),'operator'));

create table public.system_alerts (
  id uuid primary key default gen_random_uuid(),
  severity alert_severity not null,
  category text not null,
  message text not null,
  context jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  created_at timestamptz not null default now()
);
alter table public.system_alerts enable row level security;
create policy "operator reads alerts" on public.system_alerts
  for select to authenticated using (has_role(auth.uid(),'operator'));
create policy "operator acks alerts" on public.system_alerts
  for update to authenticated using (has_role(auth.uid(),'operator')) with check (has_role(auth.uid(),'operator'));
create index on public.system_alerts (severity, acknowledged_at);

create table public.error_log (
  id uuid primary key default gen_random_uuid(),
  source text,
  request_id text,
  message text not null,
  stack text,
  context jsonb,
  created_at timestamptz not null default now()
);
alter table public.error_log enable row level security;
create policy "operator reads errors" on public.error_log
  for select to authenticated using (has_role(auth.uid(),'operator'));

-- ============ updated_at triggers ============
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger t_app_settings_u before update on public.app_settings
  for each row execute function public.touch_updated_at();
create trigger t_symbols_u before update on public.symbols
  for each row execute function public.touch_updated_at();
create trigger t_strategies_u before update on public.strategies
  for each row execute function public.touch_updated_at();
create trigger t_positions_u before update on public.positions
  for each row execute function public.touch_updated_at();
