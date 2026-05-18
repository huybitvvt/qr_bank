create table if not exists public.orders (
  code text primary key,
  product_id text not null,
  product_title text not null,
  product_url text,
  amount integer not null check (amount > 0),
  customer_name text,
  customer_email text not null,
  customer_phone text,
  status text not null check (status in ('pending', 'expired', 'paid', 'activated')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  paid_at timestamptz,
  activated_at timestamptz,
  activation_token text not null unique,
  activation_code text,
  transaction_id text,
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  transaction_id text primary key,
  received_at timestamptz not null,
  status text not null,
  order_code text references public.orders(code) on delete set null,
  note text,
  payload jsonb,
  raw_body text
);

create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_customer_email_idx on public.orders(customer_email);
create index if not exists orders_created_at_idx on public.orders(created_at desc);
create index if not exists transactions_order_code_idx on public.transactions(order_code);
create index if not exists transactions_received_at_idx on public.transactions(received_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_orders_updated_at on public.orders;
create trigger set_orders_updated_at
before update on public.orders
for each row
execute function public.set_updated_at();

alter table public.orders enable row level security;
alter table public.transactions enable row level security;

drop policy if exists "orders_service_role_all" on public.orders;
create policy "orders_service_role_all"
on public.orders
for all
to service_role
using (true)
with check (true);

drop policy if exists "transactions_service_role_all" on public.transactions;
create policy "transactions_service_role_all"
on public.transactions
for all
to service_role
using (true)
with check (true);
