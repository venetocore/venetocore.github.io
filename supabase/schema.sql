-- Venetocore Magazzino: schema per Supabase.
-- Incolla tutto in SQL Editor > New query e premi Run. Si può rieseguire senza danni.

-- 1. Chi del team può entrare (email in minuscolo)
create table if not exists public.team (
  email text primary key check (email = lower(email))
);

-- 2. Design, giacenze per taglia, storico movimenti
create table if not exists public.tees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default 'nero',
  price numeric(8,2),
  threshold int not null default 3 check (threshold >= 0),
  image text,
  created_at timestamptz not null default now()
);

create table if not exists public.stock (
  tee_id uuid not null references public.tees(id) on delete cascade,
  size text not null check (size in ('XS','S','M','L','XL','XXL')),
  qty int not null default 0 check (qty >= 0),
  primary key (tee_id, size)
);

create table if not exists public.moves (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tee_id uuid references public.tees(id) on delete set null,
  tee_name text,
  size text,
  delta int not null,
  by_email text
);

-- 2b. Vendite ai clienti e ordini al fornitore
-- Prezzo di vendita e costo dal fornitore per tipo di maglietta (colore)
create table if not exists public.tee_types (
  color text primary key,
  price numeric(8,2) check (price >= 0),
  cost numeric(8,2) check (cost >= 0)
);

create table if not exists public.sales (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tee_id uuid references public.tees(id) on delete set null,
  tee_name text,
  size text not null,
  qty int not null check (qty > 0),
  customer text not null,
  payment text not null,
  unit_price numeric(8,2) not null check (unit_price >= 0),
  unit_cost numeric(8,2),
  by_email text default (auth.jwt() ->> 'email')
);

create table if not exists public.supplier_orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tee_id uuid references public.tees(id) on delete set null,
  tee_name text,
  qty jsonb not null,
  unit_cost numeric(8,2) not null check (unit_cost >= 0),
  status text not null default 'ordinato' check (status in ('ordinato','ricevuto')),
  received_at timestamptz,
  by_email text default (auth.jwt() ->> 'email')
);

-- 3. Regola base: solo chi è nella tabella team vede e modifica
create or replace function public.is_team()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team where email = lower(auth.jwt() ->> 'email'));
$$;

alter table public.team  enable row level security;
alter table public.tees  enable row level security;
alter table public.stock enable row level security;
alter table public.moves enable row level security;
alter table public.sales enable row level security;
alter table public.tee_types enable row level security;
alter table public.supplier_orders enable row level security;

drop policy if exists team_read on public.team;
create policy team_read on public.team for select to authenticated using (public.is_team());

drop policy if exists tees_all on public.tees;
create policy tees_all on public.tees for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists stock_all on public.stock;
create policy stock_all on public.stock for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists tee_types_all on public.tee_types;
create policy tee_types_all on public.tee_types for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists sales_all on public.sales;
create policy sales_all on public.sales for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists supplier_orders_all on public.supplier_orders;
create policy supplier_orders_all on public.supplier_orders for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists moves_read on public.moves;
create policy moves_read on public.moves for select to authenticated using (public.is_team());
drop policy if exists moves_insert on public.moves;
create policy moves_insert on public.moves for insert to authenticated with check (public.is_team());

-- 4. Variazioni di magazzino atomiche (due persone che toccano la stessa taglia non si sovrascrivono)
create or replace function public.adjust_stock(p_tee uuid, p_size text, p_delta int)
returns int language plpgsql security invoker set search_path = public as $$
declare v_old int; v_new int;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  select qty into v_old from public.stock where tee_id = p_tee and size = p_size for update;
  if not found then raise exception 'Taglia non trovata'; end if;
  v_new := greatest(0, v_old + p_delta);
  if v_new <> v_old then
    update public.stock set qty = v_new where tee_id = p_tee and size = p_size;
    insert into public.moves (tee_id, tee_name, size, delta, by_email)
      select p_tee, name, p_size, v_new - v_old, auth.jwt() ->> 'email' from public.tees where id = p_tee;
  end if;
  return v_new;
end $$;

create or replace function public.set_stock(p_tee uuid, p_size text, p_qty int)
returns int language plpgsql security invoker set search_path = public as $$
declare v_old int;
begin
  select qty into v_old from public.stock where tee_id = p_tee and size = p_size;
  if not found then raise exception 'Taglia non trovata'; end if;
  return public.adjust_stock(p_tee, p_size, greatest(0, p_qty) - v_old);
end $$;

revoke all on function public.adjust_stock(uuid, text, int) from public, anon;
revoke all on function public.set_stock(uuid, text, int) from public, anon;
grant execute on function public.adjust_stock(uuid, text, int) to authenticated;
grant execute on function public.set_stock(uuid, text, int) to authenticated;

-- Vendita: controlla la scorta, scala il magazzino e registra la vendita (prezzo e costo restano quelli del momento)
create or replace function public.create_sale(p_tee uuid, p_size text, p_qty int, p_customer text, p_payment text, p_price numeric)
returns bigint language plpgsql security invoker set search_path = public as $$
declare v_tee public.tees; v_have int; v_id bigint; v_cost numeric;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantità non valida'; end if;
  select * into v_tee from public.tees where id = p_tee;
  if not found then raise exception 'Design non trovato'; end if;
  select cost into v_cost from public.tee_types where color = v_tee.color;
  select qty into v_have from public.stock where tee_id = p_tee and size = p_size for update;
  if not found then raise exception 'Taglia non trovata'; end if;
  if v_have < p_qty then raise exception 'Scorta insufficiente: in magazzino ne restano %', v_have; end if;
  perform public.adjust_stock(p_tee, p_size, -p_qty);
  insert into public.sales (tee_id, tee_name, size, qty, customer, payment, unit_price, unit_cost)
    values (p_tee, v_tee.name, p_size, p_qty, trim(p_customer), p_payment, p_price, v_cost)
    returning id into v_id;
  return v_id;
end $$;

-- Eliminare una vendita rimette i pezzi in magazzino
create or replace function public.delete_sale(p_id bigint)
returns void language plpgsql security invoker set search_path = public as $$
declare v_s public.sales;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  select * into v_s from public.sales where id = p_id for update;
  if not found then return; end if;
  if v_s.tee_id is not null and exists (select 1 from public.stock where tee_id = v_s.tee_id and size = v_s.size) then
    perform public.adjust_stock(v_s.tee_id, v_s.size, v_s.qty);
  end if;
  delete from public.sales where id = p_id;
end $$;

-- Ordine fornitore arrivato: aggiunge i pezzi al magazzino, una sola volta
create or replace function public.receive_order(p_id bigint)
returns void language plpgsql security invoker set search_path = public as $$
declare v_o public.supplier_orders; k text; v text;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  select * into v_o from public.supplier_orders where id = p_id for update;
  if not found then raise exception 'Ordine non trovato'; end if;
  if v_o.status = 'ricevuto' then raise exception 'Ordine già ricevuto'; end if;
  if v_o.tee_id is null then raise exception 'Il design di questo ordine è stato eliminato'; end if;
  for k, v in select * from jsonb_each_text(v_o.qty) loop
    if v::int > 0 then perform public.adjust_stock(v_o.tee_id, k, v::int); end if;
  end loop;
  update public.supplier_orders set status = 'ricevuto', received_at = now() where id = p_id;
end $$;

revoke all on function public.create_sale(uuid, text, int, text, text, numeric) from public, anon;
revoke all on function public.delete_sale(bigint) from public, anon;
revoke all on function public.receive_order(bigint) from public, anon;
grant execute on function public.create_sale(uuid, text, int, text, text, numeric) to authenticated;
grant execute on function public.delete_sale(bigint) to authenticated;
grant execute on function public.receive_order(bigint) to authenticated;

-- 5. Aggiornamenti in tempo reale tra telefoni
do $$ declare t text; begin
  foreach t in array array['tees','stock','moves','sales','supplier_orders','tee_types'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- 6. Foto dei design (bucket pubblico in lettura, caricamento solo dal team)
insert into storage.buckets (id, name, public) values ('foto', 'foto', true)
on conflict (id) do nothing;

drop policy if exists foto_upload on storage.objects;
create policy foto_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'foto' and public.is_team());
drop policy if exists foto_delete on storage.objects;
create policy foto_delete on storage.objects for delete to authenticated
  using (bucket_id = 'foto' and public.is_team());
