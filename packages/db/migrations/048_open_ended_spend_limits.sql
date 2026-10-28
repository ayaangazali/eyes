-- S03 / ADR-049: a null cap or max bounty means no limit; the cap counts a day, week or month (UTC).
-- Defaults keep today's behavior: day window, ask at the limit, existing values unchanged.
alter table agents
  alter column daily_cap_cents drop not null,
  alter column max_bounty_cents drop not null,
  add column cap_period text not null default 'day' check (cap_period in ('day', 'week', 'month')),
  add column at_limit text not null default 'ask' check (at_limit in ('ask', 'pause', 'notify'));

-- Spent in the agent's current cap period. The name stays: 'day' is the default period.
create or replace function eyes_spent_today(p_agent_id uuid, p_now timestamptz)
returns bigint language sql stable as $$
  select coalesce(sum(case l.type when 'refund' then -l.amount_cents else l.amount_cents end), 0)::bigint
  from ledger l join tasks t on t.id = l.task_id
  where t.agent_id = p_agent_id
    and l.type in ('escrow', 'refund')
    and t.created_at >= date_trunc((select cap_period from agents where id = p_agent_id), p_now, 'UTC')
$$;

drop function eyes_update_spend_policy(uuid, bigint, bigint, text[], timestamptz);
drop function eyes_owner_console(uuid, timestamptz);
drop function eyes_agent_summary(uuid, timestamptz);

create function eyes_agent_summary(p_agent_id uuid, p_now timestamptz)
returns table (
  balance_cents bigint,
  escrowed_cents bigint,
  spent_today_cents bigint,
  daily_cap_cents bigint,
  max_bounty_cents bigint,
  allowed_task_types text[],
  cap_period text,
  at_limit text
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
    a.allowed_task_types,
    a.cap_period,
    a.at_limit
  from agents a where a.id = p_agent_id
$$;

create function eyes_owner_console(p_agent_id uuid, p_now timestamptz)
returns table (
  agent_name text,
  balance_cents bigint,
  escrowed_cents bigint,
  spent_today_cents bigint,
  daily_cap_cents bigint,
  max_bounty_cents bigint,
  allowed_task_types text[],
  cap_period text,
  at_limit text,
  tasks jsonb,
  ledger jsonb
) language sql stable as $$
  select a.name, s.balance_cents, s.escrowed_cents, s.spent_today_cents, s.daily_cap_cents, s.max_bounty_cents,
    s.allowed_task_types, s.cap_period, s.at_limit,
    coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at desc)
      from (
        select id as task_id, question, place_label, status, bounty_cents, created_at
        from tasks where agent_id = p_agent_id order by created_at desc limit 20
      ) t
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select type, amount_cents, task_id, created_at
        from ledger where agent_id = p_agent_id order by created_at desc limit 50
      ) l
    ), '[]'::jsonb)
  from agents a cross join lateral eyes_agent_summary(a.id, p_now) s
  where a.id = p_agent_id
$$;

-- Null cap or bounty saves "no limit". A null period or at_limit keeps the stored value.
create function eyes_update_spend_policy(
  p_agent_id uuid,
  p_max_bounty_cents bigint,
  p_daily_cap_cents bigint,
  p_allowed_task_types text[],
  p_cap_period text,
  p_at_limit text,
  p_now timestamptz
) returns table (
  balance_cents bigint,
  escrowed_cents bigint,
  spent_today_cents bigint,
  daily_cap_cents bigint,
  max_bounty_cents bigint,
  allowed_task_types text[],
  cap_period text,
  at_limit text
) language plpgsql as $$
begin
  update agents a set max_bounty_cents = p_max_bounty_cents, daily_cap_cents = p_daily_cap_cents,
    allowed_task_types = p_allowed_task_types,
    cap_period = coalesce(p_cap_period, a.cap_period), at_limit = coalesce(p_at_limit, a.at_limit)
  where a.id = p_agent_id;
  return query select * from eyes_agent_summary(p_agent_id, p_now);
end $$;

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
  if v_agent.daily_cap_cents is not null and v_spent + v_total > v_agent.daily_cap_cents then
    raise exception 'eyes:daily_cap_exceeded %',
      json_build_object('daily_cap_cents', v_agent.daily_cap_cents, 'spent_today_cents', v_spent,
        'cap_period', v_agent.cap_period, 'at_limit', v_agent.at_limit);
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

do $$
declare
  v_fn regprocedure;
  v_role text;
begin
  for v_fn in select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('eyes_agent_summary', 'eyes_owner_console', 'eyes_update_spend_policy')
  loop
    execute format('revoke execute on function %s from public', v_fn);
    for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
      execute format('revoke execute on function %s from %I', v_fn, v_role);
    end loop;
  end loop;
end $$;
