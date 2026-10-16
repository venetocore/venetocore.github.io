-- Da eseguire una volta sola, dopo schema.sql.
-- 1. Metti le email del team (in minuscolo). Devono essere le stesse degli utenti
--    creati in Authentication > Users.
insert into public.team (email) values
  ('tua.email@example.com'),
  ('amico1@example.com')
on conflict do nothing;

-- 2. I tre design di partenza, con tutte le taglie a zero
with t as (insert into public.tees (name, color, image) values ('Will never die', 'nero', 'img/will-never-die.jpg') returning id)
insert into public.stock (tee_id, size) select id, s from t, unnest(array['S','M','L','XL']) s;

with t as (insert into public.tees (name, color, image) values ('Nordest', 'bianco', 'img/nordest.jpg') returning id)
insert into public.stock (tee_id, size) select id, s from t, unnest(array['S','M','L','XL']) s;

with t as (insert into public.tees (name, color, image) values ('I ♫ Veneto', 'nero', 'img/i-nota-veneto.jpg') returning id)
insert into public.stock (tee_id, size) select id, s from t, unnest(array['S','M','L','XL']) s;
