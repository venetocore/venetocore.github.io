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
  cost numeric(8,2),
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
alter table public.tees add column if not exists cost numeric(8,2);

-- Prezzo di vendita e costo dal fornitore standard (un modello può averne di suoi in tees.price e tees.cost)
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  price numeric(8,2) check (price >= 0),
  cost numeric(8,2) check (cost >= 0)
);
insert into public.settings (id, price, cost) values (1, 20, 7.5) on conflict (id) do nothing;

-- Ordini dei clienti: più magliette per ordine e uno stato
create table if not exists public.customer_orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  customer text not null,
  payment text not null,
  status text not null default 'ordinato' check (status in ('ordinato','pagato','spedito','consegnato','annullato')),
  note text,
  by_email text default (auth.jwt() ->> 'email')
);

create table if not exists public.customer_order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.customer_orders(id) on delete cascade,
  tee_id uuid references public.tees(id) on delete set null,
  tee_name text,
  size text not null,
  qty int not null check (qty > 0),
  unit_price numeric(8,2) not null check (unit_price >= 0),
  unit_cost numeric(8,2)
);
create index if not exists customer_order_items_order on public.customer_order_items(order_id);

-- Se esiste la vecchia tabella sales (una maglietta per vendita), la copia una volta nei nuovi ordini.
-- La tabella sales resta come copia di sicurezza.
do $$ declare r record; v_id bigint; begin
  if to_regclass('public.sales') is not null and not exists (select 1 from public.customer_orders) then
    for r in execute 'select * from public.sales order by id' loop
      insert into public.customer_orders (created_at, customer, payment, status, by_email)
        values (r.created_at, r.customer, r.payment, 'consegnato', r.by_email) returning id into v_id;
      insert into public.customer_order_items (order_id, tee_id, tee_name, size, qty, unit_price, unit_cost)
        values (v_id, r.tee_id, r.tee_name, r.size, r.qty, r.unit_price, r.unit_cost);
    end loop;
  end if;
end $$;

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
alter table public.customer_orders enable row level security;
alter table public.customer_order_items enable row level security;
alter table public.settings enable row level security;
alter table public.supplier_orders enable row level security;

drop policy if exists team_read on public.team;
create policy team_read on public.team for select to authenticated using (public.is_team());

drop policy if exists tees_all on public.tees;
create policy tees_all on public.tees for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists stock_all on public.stock;
create policy stock_all on public.stock for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists settings_all on public.settings;
create policy settings_all on public.settings for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists customer_orders_all on public.customer_orders;
create policy customer_orders_all on public.customer_orders for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists customer_order_items_all on public.customer_order_items;
create policy customer_order_items_all on public.customer_order_items for all to authenticated using (public.is_team()) with check (public.is_team());

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

drop function if exists public.create_sale(uuid, text, int, text, text, numeric);
drop function if exists public.delete_sale(bigint);

-- Nuovo ordine cliente: controlla la scorta di ogni riga, scala il magazzino, salva prezzo e costo del momento.
-- Se una riga non ha scorta, non viene salvato niente.
create or replace function public.create_customer_order(p_customer text, p_payment text, p_status text, p_note text, p_items jsonb)
returns bigint language plpgsql security invoker set search_path = public as $$
declare v_id bigint; it jsonb; v_tee public.tees; v_have int; v_qty int; v_cost numeric; v_size text;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  if coalesce(trim(p_customer), '') = '' then raise exception 'Manca il nome del cliente'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Aggiungi almeno una maglietta'; end if;
  if p_status = 'annullato' then raise exception 'Un ordine nuovo non può essere annullato'; end if;
  insert into public.customer_orders (customer, payment, status, note)
    values (trim(p_customer), p_payment, coalesce(nullif(p_status, ''), 'ordinato'), nullif(trim(coalesce(p_note, '')), ''))
    returning id into v_id;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it ->> 'qty')::int; v_size := it ->> 'size';
    if v_qty is null or v_qty < 1 then raise exception 'Quantità non valida'; end if;
    select * into v_tee from public.tees where id = (it ->> 'tee_id')::uuid;
    if not found then raise exception 'Modello non trovato'; end if;
    select qty into v_have from public.stock where tee_id = v_tee.id and size = v_size for update;
    if not found then raise exception 'Taglia non trovata'; end if;
    if v_have < v_qty then raise exception 'Scorta insufficiente per % %: ne restano %', v_tee.name, v_size, v_have; end if;
    perform public.adjust_stock(v_tee.id, v_size, -v_qty);
    v_cost := coalesce(v_tee.cost, (select cost from public.settings where id = 1));
    insert into public.customer_order_items (order_id, tee_id, tee_name, size, qty, unit_price, unit_cost)
      values (v_id, v_tee.id, v_tee.name, v_size, v_qty, (it ->> 'price')::numeric, v_cost);
  end loop;
  return v_id;
end $$;

-- p_sign = 1 rimette in magazzino i pezzi di un ordine, -1 li ritoglie (con controllo scorta)
create or replace function public.customer_order_stock(p_id bigint, p_sign int)
returns void language plpgsql security invoker set search_path = public as $$
declare r record; v_have int;
begin
  for r in select * from public.customer_order_items where order_id = p_id and tee_id is not null loop
    select qty into v_have from public.stock where tee_id = r.tee_id and size = r.size for update;
    if not found then continue; end if;
    if p_sign < 0 and v_have < r.qty then raise exception 'Scorta insufficiente per % %: ne restano %', r.tee_name, r.size, v_have; end if;
    perform public.adjust_stock(r.tee_id, r.size, p_sign * r.qty);
  end loop;
end $$;

-- Cambio stato: annullare rimette i pezzi, togliere l'annullamento li riprende
create or replace function public.set_customer_order_status(p_id bigint, p_status text)
returns void language plpgsql security invoker set search_path = public as $$
declare v_old text;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  select status into v_old from public.customer_orders where id = p_id for update;
  if not found then raise exception 'Ordine non trovato'; end if;
  if v_old = p_status then return; end if;
  if p_status = 'annullato' then perform public.customer_order_stock(p_id, 1);
  elsif v_old = 'annullato' then perform public.customer_order_stock(p_id, -1);
  end if;
  update public.customer_orders set status = p_status where id = p_id;
end $$;

-- Eliminare un ordine non annullato rimette i pezzi in magazzino
create or replace function public.delete_customer_order(p_id bigint)
returns void language plpgsql security invoker set search_path = public as $$
declare v_old text;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  select status into v_old from public.customer_orders where id = p_id for update;
  if not found then return; end if;
  if v_old <> 'annullato' then perform public.customer_order_stock(p_id, 1); end if;
  delete from public.customer_orders where id = p_id;
end $$;

revoke all on function public.create_customer_order(text, text, text, text, jsonb) from public, anon;
revoke all on function public.customer_order_stock(bigint, int) from public, anon;
revoke all on function public.set_customer_order_status(bigint, text) from public, anon;
revoke all on function public.delete_customer_order(bigint) from public, anon;
grant execute on function public.create_customer_order(text, text, text, text, jsonb) to authenticated;
grant execute on function public.customer_order_stock(bigint, int) to authenticated;
grant execute on function public.set_customer_order_status(bigint, text) to authenticated;
grant execute on function public.delete_customer_order(bigint) to authenticated;

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

revoke all on function public.receive_order(bigint) from public, anon;
grant execute on function public.receive_order(bigint) to authenticated;

-- 5. Aggiornamenti in tempo reale tra telefoni
do $$ declare t text; begin
  foreach t in array array['tees','stock','moves','customer_orders','customer_order_items','supplier_orders','settings'] loop
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
