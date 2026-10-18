-- Ops dashboard lists (T6.32): one page at a time, newest first, by a keyset cursor on
-- (created_at, id), so rows with the same timestamp are never skipped or repeated. Filters and search
-- run here so they cover every row, not just the loaded page. `total` is the filtered count over all
-- pages (the cursor narrows only the outer query); `total_cents` (ledger) the filtered sum. Events have
-- no total: that table grows with every request, and the page polls it.

create index if not exists tickets_created on tickets (created_at desc, id desc);
create index if not exists tasks_created on tasks (created_at desc, id desc);
create index if not exists ledger_created on ledger (created_at desc, id desc);

-- p_before_*: rows older than that cursor (the next page). p_after_*: rows newer than it (live polling).
create function eyes_events_page(
  p_limit integer, p_kind text, p_level text, p_q text, p_task_id uuid,
  p_before_at timestamptz, p_before_id bigint, p_after_at timestamptz, p_after_id bigint
) returns setof events
language sql stable as $$
  select e.*
  from events e
  where (p_kind is null or e.kind = p_kind)
    and (p_level is null or e.level = p_level)
    and (p_task_id is null or e.task_id = p_task_id)
    and (p_q is null or e.summary ilike '%' || p_q || '%' or e.data::text ilike '%' || p_q || '%')
    and (p_before_at is null or (e.at, e.id) < (p_before_at, p_before_id))
    and (p_after_at is null or (e.at, e.id) > (p_after_at, p_after_id))
  order by e.at desc, e.id desc
  limit least(p_limit, 500)
$$;

-- p_state: 'open' or 'resolved' (a dispute is open while its dispute_status is open).
create function eyes_tickets_page(
  p_limit integer, p_q text, p_state text, p_kind text, p_before_at timestamptz, p_before_id bigint
) returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select k.id, k.worker_id, k.task_id, k.kind, k.status, k.message, k.created_at, k.resolved_at, k.note,
      k.dispute_status, k.reversal_owed_cents, w.banned as worker_banned,
      t.question, t.place_label, t.status as task_status, t.bounty_cents, t.fee_cents, t.lat, t.lng, t.radius_m,
      s.photo_url, s.answer_text, s.answer_bool, s.gps_ok, s.fresh_ok, s.vision_ok, s.vision_reason, s.confidence,
      s.lat as submission_lat, s.lng as submission_lng, s.created_at as submitted_at,
      count(*) over () as total
    from tickets k
    join tasks t on t.id = k.task_id
    join workers w on w.id = k.worker_id
    left join lateral (
      select * from submissions sub where sub.task_id = k.task_id order by sub.created_at desc limit 1
    ) s on true
    where (p_kind is null or k.kind = p_kind)
      and (p_state is null or (case when k.kind = 'dispute' then k.dispute_status = 'open' else k.status = 'open' end)
        = (p_state = 'open'))
      and (p_q is null or concat_ws(' ', k.id::text, k.task_id::text, t.question, k.message, t.place_label)
        ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc
  limit least(p_limit, 200)
$$;

create function eyes_tasks_page(
  p_limit integer, p_q text, p_status text, p_before_at timestamptz, p_before_id uuid
) returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select t.id, t.question, t.place_label, t.lat, t.lng, t.radius_m, t.status, t.bounty_cents, t.fee_cents,
      t.created_at, t.claimed_at, t.deadline_at, a.name as agent,
      (select count(*) from offers o where o.task_id = t.id)::integer as workers_notified,
      s.created_at as submitted_at, s.gps_ok, s.fresh_ok, s.vision_ok, s.confidence,
      s.lat as submission_lat, s.lng as submission_lng,
      (select jsonb_object_agg(l.type, l.created_at) from ledger l where l.task_id = t.id) as money_at,
      count(*) over () as total
    from tasks t
    join agents a on a.id = t.agent_id
    left join lateral (
      select * from submissions sub where sub.task_id = t.id order by sub.created_at desc limit 1
    ) s on true
    where (p_status is null or t.status = p_status)
      and (p_q is null or concat_ws(' ', t.id::text, t.question, t.place_label, a.name) ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc
  limit least(p_limit, 200)
$$;

create function eyes_ledger_page(
  p_limit integer, p_q text, p_type text, p_before_at timestamptz, p_before_id uuid
) returns table (
  id uuid, type text, amount_cents bigint, task_id uuid, created_at timestamptz, question text,
  place_label text, total bigint, total_cents numeric
) language sql stable as $$
  select * from (
    select l.id, l.type, l.amount_cents, l.task_id, l.created_at, t.question, t.place_label,
      count(*) over () as total, sum(l.amount_cents) over () as total_cents
    from ledger l
    left join tasks t on t.id = l.task_id
    where (p_type is null or l.type = p_type)
      and (p_q is null or concat_ws(' ', l.task_id::text, l.type, t.question, t.place_label) ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc
  limit least(p_limit, 200)
$$;

revoke execute on function eyes_events_page(integer, text, text, text, uuid, timestamptz, bigint, timestamptz, bigint) from public;
revoke execute on function eyes_tickets_page(integer, text, text, text, timestamptz, bigint) from public;
revoke execute on function eyes_tasks_page(integer, text, text, timestamptz, uuid) from public;
revoke execute on function eyes_ledger_page(integer, text, text, timestamptz, uuid) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_events_page(integer, text, text, text, uuid, timestamptz, bigint, timestamptz, bigint) from %I', v_role);
    execute format('revoke execute on function eyes_tickets_page(integer, text, text, text, timestamptz, bigint) from %I', v_role);
    execute format('revoke execute on function eyes_tasks_page(integer, text, text, timestamptz, uuid) from %I', v_role);
    execute format('revoke execute on function eyes_ledger_page(integer, text, text, timestamptz, uuid) from %I', v_role);
  end loop;
end $$;
