-- A repeat join now writes too, so a known phone commits and flushes WAL like a new one and timing
-- no longer tells them apart (issue #71). The no-op update keeps every column as it was and fires
-- no trigger (038 fires only on location_at, email, email_verified_at).
create or replace function eyes_join_worker(p_name text, p_phone text, p_lat double precision, p_lng double precision,
  p_now timestamptz, p_email text default null)
returns setof workers language plpgsql as $$
begin
  return query
  insert into workers (name, phone, lat, lng, created_at, email)
  values (p_name, p_phone, p_lat, p_lng, p_now,
    case when not exists (select 1 from workers where email = lower(p_email)) then lower(p_email) end)
  on conflict (phone) do update set phone = workers.phone
  returning *;
end $$;
