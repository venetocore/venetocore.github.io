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

-- 3. Regola base: solo chi è nella tabella team vede e modifica
create or replace function public.is_team()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team where email = lower(auth.jwt() ->> 'email'));
$$;

alter table public.team  enable row level security;
alter table public.tees  enable row level security;
alter table public.stock enable row level security;
alter table public.moves enable row level security;

drop policy if exists team_read on public.team;
create policy team_read on public.team for select to authenticated using (public.is_team());

drop policy if exists tees_all on public.tees;
create policy tees_all on public.tees for all to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists stock_all on public.stock;
create policy stock_all on public.stock for all to authenticated using (public.is_team()) with check (public.is_team());

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

-- 5. Aggiornamenti in tempo reale tra telefoni
do $$ begin
  alter publication supabase_realtime add table public.tees, public.stock, public.moves;
exception when duplicate_object then null; end $$;

-- 6. Foto dei design (bucket pubblico in lettura, caricamento solo dal team)
insert into storage.buckets (id, name, public) values ('foto', 'foto', true)
on conflict (id) do nothing;

drop policy if exists foto_upload on storage.objects;
create policy foto_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'foto' and public.is_team());
drop policy if exists foto_delete on storage.objects;
create policy foto_delete on storage.objects for delete to authenticated
  using (bucket_id = 'foto' and public.is_team());
