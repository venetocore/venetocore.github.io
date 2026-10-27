-- Aggiornamento: vendite anche senza scorta (pezzi «da ristampare») e ristampe assegnate agli ordini in attesa.
-- Non cancella né modifica i dati esistenti: aggiunge una colonna (a zero per gli ordini già registrati) e aggiorna le funzioni.
-- Incolla tutto in Supabase > SQL Editor > New query e premi Run. Si può rieseguire senza danni.
begin;

-- Pezzi della riga non ancora presi dal magazzino: richieste da coprire con una ristampa
alter table public.customer_order_items add column if not exists pending int not null default 0 check (pending >= 0);

-- Prende dal magazzino fino a p_qty pezzi e restituisce quanti ne ha presi
create or replace function public.take_stock(p_tee uuid, p_size text, p_qty int)
returns int language plpgsql security invoker set search_path = public as $$
declare v_have int; v_take int;
begin
  select qty into v_have from public.stock where tee_id = p_tee and size = p_size for update;
  if not found then raise exception 'Taglia non trovata'; end if;
  v_take := least(v_have, greatest(0, p_qty));
  if v_take > 0 then perform public.adjust_stock(p_tee, p_size, -v_take); end if;
  return v_take;
end $$;

-- Nuovo ordine cliente: scala dal magazzino quello che c'è, salva prezzo e costo del momento.
-- I pezzi che mancano restano in pending, da coprire con una ristampa.
create or replace function public.create_customer_order(p_customer text, p_payment text, p_status text, p_note text, p_items jsonb)
returns bigint language plpgsql security invoker set search_path = public as $$
declare v_id bigint; it jsonb; v_tee public.tees; v_take int; v_qty int; v_cost numeric; v_size text;
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
    v_take := public.take_stock(v_tee.id, v_size, v_qty);
    v_cost := coalesce(v_tee.cost, (select cost from public.settings where id = 1));
    insert into public.customer_order_items (order_id, tee_id, tee_name, size, qty, unit_price, unit_cost, pending)
      values (v_id, v_tee.id, v_tee.name, v_size, v_qty, (it ->> 'price')::numeric, v_cost, v_qty - v_take);
  end loop;
  return v_id;
end $$;

-- p_sign = 1 rimette in magazzino i pezzi presi da un ordine, -1 li riprende (quelli che mancano tornano in pending).
-- Negli ordini annullati pending non conta: nessun pezzo è preso.
create or replace function public.customer_order_stock(p_id bigint, p_sign int)
returns void language plpgsql security invoker set search_path = public as $$
declare r record; v_take int;
begin
  for r in select * from public.customer_order_items where order_id = p_id and tee_id is not null loop
    if not exists (select 1 from public.stock where tee_id = r.tee_id and size = r.size) then continue; end if;
    if p_sign > 0 then
      if r.qty - r.pending > 0 then perform public.adjust_stock(r.tee_id, r.size, r.qty - r.pending); end if;
    else
      v_take := public.take_stock(r.tee_id, r.size, r.qty);
      update public.customer_order_items set pending = r.qty - v_take where id = r.id;
    end if;
  end loop;
end $$;

-- Assegna la scorta disponibile alle righe in attesa, dagli ordini più vecchi (o solo all'ordine p_order).
-- Restituisce quanti pezzi ha assegnato.
create or replace function public.fill_backorders(p_order bigint default null)
returns int language plpgsql security invoker set search_path = public as $$
declare r record; v_take int; v_n int := 0;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  for r in select i.id, i.tee_id, i.size, i.pending from public.customer_order_items i
      join public.customer_orders o on o.id = i.order_id
      where i.pending > 0 and i.tee_id is not null and o.status <> 'annullato' and (p_order is null or o.id = p_order)
      order by o.created_at, i.id for update of i loop
    if not exists (select 1 from public.stock where tee_id = r.tee_id and size = r.size) then continue; end if;
    v_take := public.take_stock(r.tee_id, r.size, r.pending);
    if v_take > 0 then
      update public.customer_order_items set pending = pending - v_take where id = r.id;
      v_n := v_n + v_take;
    end if;
  end loop;
  return v_n;
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

revoke all on function public.take_stock(uuid, text, int) from public, anon;
revoke all on function public.fill_backorders(bigint) from public, anon;
grant execute on function public.take_stock(uuid, text, int) to authenticated;
grant execute on function public.fill_backorders(bigint) to authenticated;
revoke all on function public.create_customer_order(text, text, text, text, jsonb) from public, anon;
revoke all on function public.customer_order_stock(bigint, int) from public, anon;
revoke all on function public.set_customer_order_status(bigint, text) from public, anon;
revoke all on function public.delete_customer_order(bigint) from public, anon;
grant execute on function public.create_customer_order(text, text, text, text, jsonb) to authenticated;
grant execute on function public.customer_order_stock(bigint, int) to authenticated;
grant execute on function public.set_customer_order_status(bigint, text) to authenticated;
grant execute on function public.delete_customer_order(bigint) to authenticated;

-- Ristampa arrivata: aggiunge i pezzi di ogni modello al magazzino, una sola volta,
-- poi li assegna agli ordini in attesa. Restituisce quanti pezzi ha assegnato.
-- Le ristampe nuove hanno le righe in items; quelle vecchie usano tee_id e qty.
drop function if exists public.receive_order(bigint);
create or replace function public.receive_order(p_id bigint)
returns int language plpgsql security invoker set search_path = public as $$
declare v_o public.supplier_orders; line jsonb; v_tee uuid; k text; v text;
begin
  if not public.is_team() then raise exception 'Non autorizzato'; end if;
  select * into v_o from public.supplier_orders where id = p_id for update;
  if not found then raise exception 'Ristampa non trovata'; end if;
  if v_o.status = 'ricevuto' then raise exception 'Ristampa già arrivata'; end if;
  if v_o.items is not null and jsonb_array_length(v_o.items) > 0 then
    for line in select * from jsonb_array_elements(v_o.items) loop
      v_tee := (line ->> 'tee_id')::uuid;
      if not exists (select 1 from public.tees where id = v_tee) then
        raise exception 'Il modello % di questa ristampa è stato eliminato', line ->> 'tee_name';
      end if;
      for k, v in select * from jsonb_each_text(line -> 'qty') loop
        if v::int > 0 then perform public.adjust_stock(v_tee, k, v::int); end if;
      end loop;
    end loop;
  else
    if v_o.tee_id is null then raise exception 'Il modello di questa ristampa è stato eliminato'; end if;
    for k, v in select * from jsonb_each_text(v_o.qty) loop
      if v::int > 0 then perform public.adjust_stock(v_o.tee_id, k, v::int); end if;
    end loop;
  end if;
  update public.supplier_orders set status = 'ricevuto', received_at = now() where id = p_id;
  return public.fill_backorders();
end $$;

revoke all on function public.receive_order(bigint) from public, anon;
grant execute on function public.receive_order(bigint) to authenticated;

commit;
