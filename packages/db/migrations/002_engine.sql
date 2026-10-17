create function eyes_agent_by_key_hash(p_api_key_hash text)
returns setof agents language sql stable as $$
  select * from agents where api_key_hash = p_api_key_hash
$$;

create function eyes_credit_topup(p_agent_id uuid, p_amount_cents bigint, p_stripe_ref text, p_now timestamptz)
returns setof agents language plpgsql as $$
begin
  insert into ledger (agent_id, type, amount_cents, stripe_ref, created_at)
  values (p_agent_id, 'topup', p_amount_cents, p_stripe_ref, p_now)
  on conflict do nothing;
  if found then
    update agents set balance_cents = balance_cents + p_amount_cents where id = p_agent_id;
  end if;
  return query select * from agents where id = p_agent_id;
end $$;

create function eyes_signup(p_name text, p_api_key_hash text, p_grant_cents bigint, p_now timestamptz)
returns setof agents language plpgsql as $$
declare
  v_id uuid;
begin
  insert into agents (name, api_key_hash, created_at) values (p_name, p_api_key_hash, p_now)
  returning id into v_id;
  if p_grant_cents > 0 then
    perform * from eyes_credit_topup(v_id, p_grant_cents, 'signup:' || v_id, p_now);
  end if;
  return query select * from agents where id = v_id;
end $$;

create function eyes_spent_today(p_agent_id uuid, p_now timestamptz)
returns bigint language sql stable as $$
  select coalesce(sum(case l.type when 'refund' then -l.amount_cents else l.amount_cents end), 0)::bigint
  from ledger l join tasks t on t.id = l.task_id
  where t.agent_id = p_agent_id
    and l.type in ('escrow', 'refund')
    and t.created_at >= date_trunc('day', p_now, 'UTC')
$$;

create function eyes_agent_summary(p_agent_id uuid, p_now timestamptz)
returns table (
  balance_cents bigint,
  escrowed_cents bigint,
  spent_today_cents bigint,
  daily_cap_cents bigint,
  max_bounty_cents bigint,
  allowed_task_types text[]
) language sql stable as $$
  select a.balance_cents,
    coalesce((
      select sum(case l.type when 'escrow' then l.amount_cents else -l.amount_cents end)
      from ledger l join tasks t on t.id = l.task_id
      where t.agent_id = a.id and l.type in ('escrow', 'release', 'fee', 'refund')
    ), 0)::bigint,
    eyes_spent_today(a.id, p_now),
    a.daily_cap_cents,
    a.max_bounty_cents,
    a.allowed_task_types
  from agents a where a.id = p_agent_id
$$;

create function eyes_nearby_workers(p_lat double precision, p_lng double precision, p_radius_m integer, p_limit integer)
returns table (worker_id uuid, phone text, distance_m double precision) language sql stable as $$
  select id, phone, d from (
    select w.id, w.phone, 2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in
  ) nearby
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create function eyes_post_task(
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

  if coalesce(cardinality(p_worker_ids), 0) = 0 then
    raise exception 'eyes:no_workers_nearby';
  end if;

  v_spent := eyes_spent_today(p_agent_id, p_now);
  if v_spent + v_total > v_agent.daily_cap_cents then
    raise exception 'eyes:daily_cap_exceeded %',
      json_build_object('daily_cap_cents', v_agent.daily_cap_cents, 'spent_today_cents', v_spent);
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

create function eyes_task_detail(p_task_id uuid)
returns table (task tasks, submission submissions, worker_rating numeric) language sql stable as $$
  select t, s.sub, w.rating
  from tasks t
  left join lateral (
    select sub from submissions sub where sub.task_id = t.id order by sub.created_at desc limit 1
  ) s on true
  left join workers w on w.id = t.claimed_by
  where t.id = p_task_id
$$;

create function eyes_cancel_task(p_agent_id uuid, p_task_id uuid, p_now timestamptz)
returns setof tasks language plpgsql as $$
declare
  v_task tasks;
begin
  select * into v_task from tasks where id = p_task_id and agent_id = p_agent_id for update;
  if not found then
    raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id);
  end if;
  if v_task.status <> 'dispatched' then
    raise exception 'eyes:task_not_cancellable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  update tasks set status = 'refunded' where id = p_task_id returning * into v_task;
  insert into ledger (agent_id, task_id, type, amount_cents, created_at)
  values (p_agent_id, p_task_id, 'refund', v_task.bounty_cents + v_task.fee_cents, p_now);
  update agents set balance_cents = balance_cents + v_task.bounty_cents + v_task.fee_cents where id = p_agent_id;
  return next v_task;
end $$;

create function eyes_expire_overdue(p_now timestamptz)
returns setof tasks language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('eyes_expire_overdue'));
  return query
  with overdue as (
    update tasks set status = 'expired'
    where status in ('dispatched', 'claimed') and deadline_at <= p_now
    returning *
  ), refunds as (
    insert into ledger (agent_id, task_id, type, amount_cents, created_at)
    select agent_id, id, 'refund', bounty_cents + fee_cents, p_now from overdue
    on conflict do nothing
    returning agent_id, amount_cents
  ), credited as (
    update agents a set balance_cents = a.balance_cents + r.total
    from (select agent_id, sum(amount_cents) as total from refunds group by agent_id) r
    where a.id = r.agent_id
  )
  select * from overdue;
end $$;

create function eyes_dispute(p_agent_id uuid, p_task_id uuid, p_reason text)
returns setof tasks language plpgsql as $$
declare
  v_task tasks;
begin
  select * into v_task from tasks where id = p_task_id and agent_id = p_agent_id for update;
  if not found then
    raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id);
  end if;
  if v_task.status not in ('verified', 'paid', 'needs_review') then
    raise exception 'eyes:task_not_disputable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  update tasks set status = 'disputed', dispute_reason = p_reason where id = p_task_id returning * into v_task;
  return next v_task;
end $$;

create function eyes_worker(p_worker_id uuid, p_phone text)
returns setof workers language sql stable as $$
  select * from workers where id = p_worker_id or phone = p_phone
$$;

create function eyes_join_worker(p_name text, p_phone text, p_lat double precision, p_lng double precision, p_now timestamptz)
returns setof workers language sql as $$
  insert into workers (name, phone, lat, lng, created_at) values (p_name, p_phone, p_lat, p_lng, p_now)
  on conflict (phone) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng
  returning *
$$;

create function eyes_set_worker_opt_in(p_phone text, p_opted_in boolean)
returns setof workers language sql as $$
  update workers set opted_in = p_opted_in, available = p_opted_in where phone = p_phone returning *
$$;

create function eyes_set_worker_stripe_account(p_worker_id uuid, p_account_id text)
returns setof workers language sql as $$
  update workers set stripe_account_id = coalesce(stripe_account_id, p_account_id) where id = p_worker_id returning *
$$;

create function eyes_claim(p_worker_id uuid, p_now timestamptz)
returns table (outcome text, task tasks) language plpgsql as $$
declare
  v_task tasks;
  v_won tasks;
begin
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
    else
      return query select 'lost', v_task;
    end if;
    return;
  end if;

  select t.* into v_task
  from offers o join tasks t on t.id = o.task_id
  where o.worker_id = p_worker_id and t.deadline_at > p_now
    and ((t.claimed_by = p_worker_id and t.status = 'claimed') or t.claimed_by <> p_worker_id)
  order by t.claimed_by = p_worker_id desc, o.sent_at desc
  limit 1;
  if found then
    return query select case when v_task.claimed_by = p_worker_id then 'already_yours' else 'lost' end, v_task;
  end if;
end $$;

create function eyes_submit(
  p_task_id uuid,
  p_worker_id uuid,
  p_photo_url text,
  p_answer_text text,
  p_answer_bool boolean,
  p_lat double precision,
  p_lng double precision,
  p_captured_at timestamptz,
  p_gps_ok boolean,
  p_fresh_ok boolean,
  p_vision_ok boolean,
  p_vision_reason text,
  p_confidence real,
  p_auto_approve boolean,
  p_now timestamptz
) returns setof tasks language plpgsql as $$
declare
  v_task tasks;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if v_task.claimed_by is distinct from p_worker_id then
    raise exception 'eyes:task_already_claimed';
  end if;
  if v_task.status <> 'claimed' then
    raise exception 'eyes:offer_invalid %', json_build_object('status', v_task.status);
  end if;

  insert into submissions (task_id, worker_id, photo_url, answer_text, answer_bool, lat, lng, captured_at,
    gps_ok, fresh_ok, vision_ok, vision_reason, confidence, source, created_at)
  values (p_task_id, p_worker_id, p_photo_url, p_answer_text, p_answer_bool, p_lat, p_lng, p_captured_at,
    p_gps_ok, p_fresh_ok, p_vision_ok, p_vision_reason, p_confidence, 'capture', p_now);

  if p_auto_approve then
    update tasks set status = 'verified' where id = p_task_id returning * into v_task;
    insert into ledger (agent_id, worker_id, task_id, type, amount_cents, created_at)
    values (v_task.agent_id, p_worker_id, p_task_id, 'release', v_task.bounty_cents, p_now);
    if v_task.fee_cents > 0 then
      insert into ledger (agent_id, task_id, type, amount_cents, created_at)
      values (v_task.agent_id, p_task_id, 'fee', v_task.fee_cents, p_now);
    end if;
  else
    update tasks set status = 'needs_review' where id = p_task_id returning * into v_task;
  end if;
  return next v_task;
end $$;

create function eyes_record_payout(p_task_id uuid, p_transfer_id text, p_now timestamptz)
returns setof tasks language plpgsql as $$
begin
  insert into ledger (worker_id, task_id, type, amount_cents, stripe_ref, created_at)
  select claimed_by, id, 'payout', bounty_cents, p_transfer_id, p_now from tasks where id = p_task_id
  on conflict (task_id, type) where task_id is not null do nothing;
  return query update tasks set status = 'paid' where id = p_task_id and status = 'verified' returning *;
end $$;

create function eyes_pending_payouts(p_account_id text)
returns table (task tasks, phone text) language sql stable as $$
  select t, w.phone
  from workers w join tasks t on t.claimed_by = w.id
  where w.stripe_account_id = p_account_id and t.status = 'verified'
$$;

do $$
declare
  v_fn regprocedure;
  v_role text;
begin
  for v_fn in select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'eyes\_%'
  loop
    execute format('revoke execute on function %s from public', v_fn);
    for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
      execute format('revoke execute on function %s from %I', v_fn, v_role);
    end loop;
  end loop;
end $$;
