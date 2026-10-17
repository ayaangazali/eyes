create or replace function eyes_nearby_workers(p_lat double precision, p_lng double precision, p_radius_m integer, p_limit integer)
returns table (worker_id uuid, phone text, distance_m double precision) language sql stable as $$
  select id, phone, d from (
    select w.id, w.phone, 2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
  ) nearby
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create or replace function eyes_claim(p_worker_id uuid, p_now timestamptz)
returns table (outcome text, task tasks) language plpgsql as $$
declare
  v_task tasks;
  v_won tasks;
begin
  if not exists (select 1 from workers where id = p_worker_id and opted_in and available) then
    return;
  end if;

  return query
  select 'already_yours', t from tasks t
  where t.claimed_by = p_worker_id and t.status = 'claimed' and t.deadline_at > p_now
  order by t.claimed_at desc
  limit 1;
  if found then
    return;
  end if;

  select t.* into v_task
  from offers o join tasks t on t.id = o.task_id
  where o.worker_id = p_worker_id and t.status = 'dispatched' and t.deadline_at > p_now
  order by o.sent_at desc
  limit 1;
  if found then
    update tasks set status = 'claimed', claimed_by = p_worker_id, claimed_at = p_now
    where id = v_task.id and status = 'dispatched'
    returning * into v_won;
    if found then
      return query select 'won', v_won;
      return;
    end if;
    return query
    select case when t.claimed_by = p_worker_id then 'already_yours' else 'lost' end, t
    from tasks t where t.id = v_task.id and t.claimed_by is not null;
    return;
  end if;

  return query
  select 'lost', t
  from offers o join tasks t on t.id = o.task_id
  where o.worker_id = p_worker_id and t.deadline_at > p_now and t.claimed_by <> p_worker_id
  order by o.sent_at desc
  limit 1;
end $$;

revoke execute on function eyes_nearby_workers(double precision, double precision, integer, integer) from public;
revoke execute on function eyes_claim(uuid, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_nearby_workers(double precision, double precision, integer, integer) from %I', v_role);
    execute format('revoke execute on function eyes_claim(uuid, timestamptz) from %I', v_role);
  end loop;
end $$;
