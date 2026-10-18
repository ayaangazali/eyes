-- Worker location stays current without re-joining (ADR-024, T6.6). Only the latest fix is kept:
-- lat/lng are overwritten in place, and STOP deletes them (so they become nullable). Rows from
-- before this migration have no location_at; their join time counts as the fix time.
alter table workers
  alter column lat drop not null,
  alter column lng drop not null,
  add column location_at timestamptz,
  add column location_accuracy_m double precision,
  add column location_source text check (location_source in ('shortcut', 'here_link', 'capture', 'findmy')),
  add column location_token_hash text unique,
  add column location_received_at timestamptz,
  add column location_day_start timestamptz,
  add column location_day_count integer not null default 0;

create table worker_pings (
  nonce text primary key,
  worker_id uuid not null references workers(id),
  task_id uuid references tasks(id),
  sent_at timestamptz not null,
  answered_at timestamptz
);
create index worker_pings_worker on worker_pings (worker_id, sent_at desc);
alter table worker_pings enable row level security;

-- Defaults on p_max_age/p_now keep the old 4- and 3-argument calls working while the server rolls over.
drop function eyes_nearby_workers(double precision, double precision, integer, integer);
create function eyes_nearby_workers(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval default '24 hours', p_now timestamptz default now())
returns table (worker_id uuid, phone text, distance_m double precision) language sql stable as $$
  select id, phone, d from (
    select w.id, w.phone, 2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and w.lat is not null
      and coalesce(w.location_at, w.created_at) > p_now - p_max_age
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
  ) nearby
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

drop function eyes_reoffer(uuid, uuid, timestamptz);
create function eyes_reoffer(p_task_id uuid, p_released_by uuid, p_now timestamptz, p_max_age interval default '24 hours')
returns setof workers language sql as $$
  update offers o set sent_at = p_now
  from tasks t, workers w
  where o.task_id = p_task_id and t.id = o.task_id and w.id = o.worker_id
    and o.sent_at = t.created_at
    and t.status = 'dispatched' and t.deadline_at > p_now
    and w.id <> p_released_by and w.available and w.opted_in and w.lat is not null
    and coalesce(w.location_at, w.created_at) > p_now - p_max_age
    and not exists (select 1 from tasks c where c.claimed_by = w.id and c.status in ('claimed', 'submitted'))
  returning w.*
$$;

-- Ping candidates: idle opted-in workers whose last fix is stale but was within the radius, nearest
-- first, skipping anyone pinged in the last hour (Inkbox allows 100 iMessages a day per line).
create function eyes_ping_candidates(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval, p_now timestamptz)
returns table (worker_id uuid, phone text, distance_m double precision) language sql stable as $$
  select id, phone, d from (
    select w.id, w.phone, 2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and w.lat is not null
      and coalesce(w.location_at, w.created_at) <= p_now - p_max_age
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
      and not exists (select 1 from worker_pings p where p.worker_id = w.id and p.sent_at > p_now - interval '1 hour')
  ) stale
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create function eyes_record_pings(p_pings jsonb, p_now timestamptz)
returns setof worker_pings language sql as $$
  insert into worker_pings (nonce, worker_id, task_id, sent_at)
  select p.nonce, p.worker_id, p.task_id, p_now
  from jsonb_to_recordset(p_pings) as p(nonce text, worker_id uuid, task_id uuid)
  returning *
$$;

-- After pinged workers had time to answer: offer the task to fresh nearby workers who do not have
-- it yet, up to p_limit offers in total.
create function eyes_offer_more(p_task_id uuid, p_radius_m integer, p_limit integer, p_max_age interval, p_now timestamptz)
returns table (worker_id uuid, phone text, distance_m double precision) language plpgsql as $$
declare
  v_task tasks;
  v_room integer;
begin
  select * into v_task from tasks where id = p_task_id and status = 'dispatched' and deadline_at > p_now for update;
  if not found then
    return;
  end if;
  v_room := p_limit - (select count(*) from offers where task_id = p_task_id);
  if v_room <= 0 then
    return;
  end if;
  return query
  with picked as (
    select n.worker_id, n.phone, n.distance_m
    from eyes_nearby_workers(v_task.lat, v_task.lng, p_radius_m, null, p_max_age, p_now) n
    where not exists (select 1 from offers o where o.task_id = p_task_id and o.worker_id = n.worker_id)
    order by n.distance_m
    limit v_room
  ), ins as (
    insert into offers (task_id, worker_id, sent_at) select p_task_id, picked.worker_id, p_now from picked
  )
  select * from picked;
end $$;

-- At most one fix per p_min_interval_s and p_daily_max per rolling day per worker (the server passes
-- EYES_LOCATION_MIN_INTERVAL_S and EYES_LOCATION_DAILY_MAX), checked in the same UPDATE that stores
-- the fix, so concurrent posts cannot both pass. A matching ping is marked answered even when the
-- fix itself is rate limited. Opted-out workers get 'not_found', like an unknown worker.
create function eyes_store_location(p_worker_id uuid, p_lat double precision, p_lng double precision,
  p_accuracy_m double precision, p_source text, p_captured_at timestamptz, p_ping_nonce text,
  p_min_interval_s integer, p_daily_max integer, p_now timestamptz)
returns setof text language plpgsql as $$
begin
  if p_ping_nonce is not null then
    update worker_pings set answered_at = p_now
    where nonce = p_ping_nonce and worker_id = p_worker_id and answered_at is null;
  end if;
  update workers set
    lat = p_lat,
    lng = p_lng,
    location_at = least(coalesce(p_captured_at, p_now), p_now),
    location_accuracy_m = p_accuracy_m,
    location_source = p_source,
    location_received_at = p_now,
    location_day_count = case when location_day_start > p_now - interval '1 day' then location_day_count + 1 else 1 end,
    location_day_start = case when location_day_start > p_now - interval '1 day' then location_day_start else p_now end
  where id = p_worker_id and opted_in
    and (location_received_at is null or location_received_at <= p_now - make_interval(secs => p_min_interval_s))
    and (location_day_start is null or location_day_start <= p_now - interval '1 day' or location_day_count < p_daily_max);
  if found then
    return query select 'stored';
  elsif exists (select 1 from workers where id = p_worker_id and opted_in) then
    return query select 'rate_limited';
  else
    return query select 'not_found';
  end if;
end $$;

create function eyes_worker_by_location_token(p_token_hash text)
returns setof workers language sql stable as $$
  select * from workers where location_token_hash = p_token_hash and opted_in
$$;

create function eyes_rotate_location_token(p_worker_id uuid, p_token_hash text)
returns setof workers language sql as $$
  update workers set location_token_hash = p_token_hash where id = p_worker_id and opted_in returning *
$$;

-- STOP also deletes the fix and revokes the location token. Same signature as 002.
create or replace function eyes_set_worker_opt_in(p_phone text, p_opted_in boolean)
returns setof workers language sql as $$
  update workers set
    opted_in = p_opted_in,
    available = p_opted_in,
    lat = case when p_opted_in then lat end,
    lng = case when p_opted_in then lng end,
    location_at = case when p_opted_in then location_at end,
    location_accuracy_m = case when p_opted_in then location_accuracy_m end,
    location_source = case when p_opted_in then location_source end,
    location_token_hash = case when p_opted_in then location_token_hash end
  where phone = p_phone
  returning *
$$;

do $$
declare
  v_fn text;
  v_role text;
begin
  foreach v_fn in array array[
    'eyes_nearby_workers(double precision, double precision, integer, integer, interval, timestamptz)',
    'eyes_reoffer(uuid, uuid, timestamptz, interval)',
    'eyes_ping_candidates(double precision, double precision, integer, integer, interval, timestamptz)',
    'eyes_record_pings(jsonb, timestamptz)',
    'eyes_offer_more(uuid, integer, integer, interval, timestamptz)',
    'eyes_store_location(uuid, double precision, double precision, double precision, text, timestamptz, text, integer, integer, timestamptz)',
    'eyes_worker_by_location_token(text)',
    'eyes_rotate_location_token(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public', v_fn);
    for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
      execute format('revoke execute on function %s from %I', v_fn, v_role);
      execute format('revoke all on table worker_pings from %I', v_role);
    end loop;
  end loop;
end $$;
