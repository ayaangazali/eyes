-- Per-agent request limits (S08). eyes_rate_hit counts calls in Postgres so every server process
-- shares one count. eyes_post_task gains an open-task cap; null keeps the old behavior (the
-- operator-approved eyes_post_reviewed_task path passes none).
create table agent_rate_hits (
  key text not null,
  at timestamptz not null
);
create index agent_rate_hits_key_at on agent_rate_hits (key, at);
create index agent_rate_hits_at on agent_rate_hits (at);
alter table agent_rate_hits enable row level security;
revoke all on table agent_rate_hits from public;

-- Records one call unless the key already has p_max calls in the window; returns seconds to wait, 0 if recorded.
create function eyes_rate_hit(p_key text, p_max integer, p_window_s integer, p_now timestamptz)
returns table (retry_after_s integer) language plpgsql as $$
declare
  v_count integer;
  v_oldest timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));
  delete from agent_rate_hits where at <= p_now - interval '1 day';
  delete from agent_rate_hits where key = p_key and at <= p_now - make_interval(secs => p_window_s);
  select count(*), min(at) into v_count, v_oldest from agent_rate_hits where key = p_key;
  if v_count >= p_max then
    return query select greatest(1, ceil(extract(epoch from v_oldest + make_interval(secs => p_window_s) - p_now))::integer);
    return;
  end if;
  insert into agent_rate_hits (key, at) values (p_key, p_now);
  return query select 0;
end $$;
revoke execute on function eyes_rate_hit(text, integer, integer, timestamptz) from public;

drop function eyes_post_task(uuid, text, text, text, double precision, double precision, integer, bigint, bigint, boolean, integer, text, uuid[], timestamptz);

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
  p_now timestamptz,
  p_max_open integer default null
) returns table (task tasks, created boolean, workers_notified integer) language plpgsql as $$
declare
  v_agent agents;
  v_task tasks;
  v_total bigint := p_bounty_cents + p_fee_cents;
  v_spent bigint;
  v_open bigint;
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

  if p_max_open is not null then
    select count(*) into v_open from tasks t
    where t.agent_id = p_agent_id and t.status in ('dispatched', 'claimed') and t.deadline_at > p_now;
    if v_open >= p_max_open then
      raise exception 'eyes:rate_limited %',
        json_build_object('retry_after_s', 60, 'open_tasks', v_open, 'max_open_tasks', p_max_open);
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
