create function eyes_stop_worker(p_worker_id uuid, p_now timestamptz)
returns setof tasks language plpgsql as $$
declare
  v_phone text;
begin
  select phone into v_phone from workers where id = p_worker_id for update;
  if not found then return; end if;
  return query select * from eyes_release_claim(p_worker_id, p_now);
  perform eyes_set_worker_opt_in(v_phone, false);
end $$;

revoke execute on function eyes_stop_worker(uuid, timestamptz) from public;

create or replace function eyes_post_task(
  p_agent_id uuid,
  p_question text,
  p_task_type text,
  p_place_label text,
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer,
  p_bounty_cents bigint,
  p_fee_cents bigint,
  p_require_photo boolean,
  p_deadline_minutes integer,
  p_idempotency_key text,
  p_worker_ids uuid[],
  p_now timestamptz
) returns table (task tasks, created boolean, workers_notified integer) language plpgsql as $$
declare
  v_agent agents;
  v_task tasks;
  v_total bigint := p_bounty_cents + p_fee_cents;
  v_spent bigint;
begin
  -- Recheck stale nearby results under locks before spending; deterministic worker order.
  perform 1 from workers where id = any(p_worker_ids) order by id for update;
  p_worker_ids := array(select w.id from workers w where w.id = any(p_worker_ids)
    and w.opted_in and w.available and not w.banned and w.dispute_hold_at is null
    and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
    and not exists (select 1 from offers o join tasks t on t.id = o.task_id
      where o.worker_id = w.id and t.status = 'dispatched' and t.deadline_at > p_now));
  select * into v_agent from agents where id = p_agent_id for update;

  if p_idempotency_key is not null then
    select * into v_task from tasks t where t.agent_id = p_agent_id and t.idempotency_key = p_idempotency_key;
    if found then
      if (v_task.question, v_task.task_type, v_task.place_label, v_task.lat, v_task.lng,
          v_task.bounty_cents, v_task.require_photo, v_task.deadline_at - v_task.created_at)
         is distinct from
         (p_question, p_task_type, p_place_label, p_lat, p_lng,
          p_bounty_cents, p_require_photo, make_interval(mins => p_deadline_minutes)) then
        raise exception 'eyes:idempotency_conflict %', json_build_object('task_id', v_task.id);
      end if;
      return query select v_task, false, (select count(*)::integer from offers o where o.task_id = v_task.id);
      return;
    end if;
  end if;

  v_spent := eyes_spent_today(p_agent_id, p_now);
  if v_spent + v_total > v_agent.daily_cap_cents then
    raise exception 'eyes:daily_cap_exceeded %',
      json_build_object('daily_cap_cents', v_agent.daily_cap_cents, 'spent_today_cents', v_spent);
  end if;

  if coalesce(cardinality(p_worker_ids), 0) = 0 then
    raise exception 'eyes:no_workers_nearby';
  end if;

  if v_agent.balance_cents < v_total then
    raise exception 'eyes:insufficient_balance %',
      json_build_object('balance_cents', v_agent.balance_cents, 'needed_cents', v_total);
  end if;

  update agents set balance_cents = balance_cents - v_total where id = p_agent_id;

  insert into tasks (agent_id, question, task_type, place_label, lat, lng, radius_m, bounty_cents, fee_cents,
    require_photo, deadline_at, idempotency_key, created_at)
  values (p_agent_id, p_question, p_task_type, p_place_label, p_lat, p_lng, p_radius_m, p_bounty_cents, p_fee_cents,
    p_require_photo, p_now + make_interval(mins => p_deadline_minutes), p_idempotency_key, p_now)
  returning * into v_task;

  insert into ledger (agent_id, task_id, type, amount_cents, created_at)
  values (p_agent_id, v_task.id, 'escrow', v_total, p_now);

  insert into offers (task_id, worker_id, sent_at)
  select v_task.id, w, p_now from unnest(p_worker_ids) w;

  return query select v_task, true, cardinality(p_worker_ids);
end $$;

create or replace function eyes_nearby_workers(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval default '24 hours', p_now timestamptz default now())
returns table (worker_id uuid, phone text, email text, distance_m double precision) language sql stable as $$
  select id, phone, email, d from (
    select w.id, w.phone, case when w.email_verified_at is not null then w.email end as email,
      2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and not w.banned and w.dispute_hold_at is null and w.lat is not null
      and coalesce(w.location_at, w.created_at) > p_now - p_max_age
      and not exists (select 1 from offers o join tasks t on t.id = o.task_id
        where o.worker_id = w.id and t.status = 'dispatched' and t.deadline_at > p_now)
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
  ) nearby
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create or replace function eyes_reoffer(p_task_id uuid, p_released_by uuid, p_now timestamptz, p_max_age interval default '24 hours')
returns setof workers language plpgsql as $$
begin
  perform 1 from workers w join offers o on o.worker_id = w.id
    where o.task_id = p_task_id order by w.id for update of w;
  return query update offers o set sent_at = p_now
  from tasks t, workers w
  where o.task_id = p_task_id and t.id = o.task_id and w.id = o.worker_id
    and o.sent_at = t.created_at
    and t.status = 'dispatched' and t.deadline_at > p_now
    and w.id <> p_released_by and w.available and w.opted_in and not w.banned and w.dispute_hold_at is null and w.lat is not null
    and coalesce(w.location_at, w.created_at) > p_now - p_max_age
    and not exists (select 1 from offers other join tasks active on active.id = other.task_id
      where other.worker_id = w.id and other.task_id <> p_task_id
        and active.status = 'dispatched' and active.deadline_at > p_now)
    and not exists (select 1 from tasks c where c.claimed_by = w.id and c.status in ('claimed', 'submitted'))
  returning w.*;
end $$;

