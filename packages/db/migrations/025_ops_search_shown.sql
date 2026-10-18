-- Ops list search matches only what a row shows (T6.32): "18" no longer hits a full uuid, a Stripe
-- reference, cents or a UTC timestamp. Dates match as the operator's browser shows them (`p_tz`, the
-- browser's IANA zone, format of `stamp()` in ops-view/format.ts for en-US), amounts as "$3.00", ids
-- by their 8-character prefix, kinds and types by their label. Ledger, tasks and events also take a
-- date window [p_from, p_to); the new parameters default to null, so a server still on the old calls
-- keeps working during a deploy. Labels mirror ops-view (LEDGER_LABEL, SOURCES, LEVELS, statusLabel).

-- "Oct 17, 08:13:45 PM", as toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", ...}).
create function eyes_shown_at(p_at timestamptz, p_tz text) returns text
language sql stable as $$
  select to_char(p_at at time zone coalesce(p_tz, 'UTC'), 'Mon FMDD, HH12:MI:SS AM')
$$;

create function eyes_shown_usd(p_cents bigint) returns text
language sql immutable as $$
  select '$' || to_char(coalesce(p_cents, 0) / 100.0, 'FM999999990.00')
$$;

drop function eyes_events_page(integer, text, text, text, uuid, timestamptz, bigint, timestamptz, bigint);
create function eyes_events_page(
  p_limit integer, p_kind text, p_level text, p_q text, p_task_id uuid,
  p_before_at timestamptz, p_before_id bigint, p_after_at timestamptz, p_after_id bigint,
  p_tz text default null, p_from timestamptz default null, p_to timestamptz default null
) returns setof events
language sql stable as $$
  select e.*
  from events e
  where (p_kind is null or e.kind = p_kind)
    and (p_level is null or e.level = p_level)
    and (p_task_id is null or e.task_id = p_task_id)
    and (p_from is null or e.at >= p_from)
    and (p_to is null or e.at < p_to)
    and (p_q is null or concat_ws(' ',
      eyes_shown_at(e.at, p_tz),
      '{"info":"Info","warn":"Warning","error":"Error"}'::jsonb ->> e.level,
      coalesce('{"http":"Web request","mcp":"MCP","call":"Agent call","task":"Task","ledger":"Money",
        "payout":"Payout","text":"Texting","reply":"Text reply","email":"Email","webhook":"Webhook",
        "safety":"Safety check","vision":"Photo check","ticket":"Support","ops":"Operator","auth":"Sign-in",
        "log":"Server log"}'::jsonb ->> e.kind, e.kind),
      e.summary) ilike '%' || p_q || '%')
    and (p_before_at is null or (e.at, e.id) < (p_before_at, p_before_id))
    and (p_after_at is null or (e.at, e.id) > (p_after_at, p_after_id))
  order by e.at desc, e.id desc
  limit least(p_limit, 500)
$$;

-- Same signature: the row shows "#id question", kind, state, place and bounty.
create or replace function eyes_tickets_page(
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
      and (p_q is null or concat_ws(' ', '#' || k.id, t.question, case when k.kind = 'dispute' then 'Dispute' else 'Help' end,
        case when k.kind = 'dispute' then coalesce(k.dispute_status, 'open') when k.status = 'open' then 'open' else 'resolved' end,
        t.place_label, eyes_shown_usd(t.bounty_cents), left(k.task_id::text, 8))
        ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc
  limit least(p_limit, 200)
$$;

drop function eyes_tasks_page(integer, text, text, timestamptz, uuid);
create function eyes_tasks_page(
  p_limit integer, p_q text, p_status text, p_before_at timestamptz, p_before_id uuid,
  p_tz text default null, p_from timestamptz default null, p_to timestamptz default null
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
      and (p_from is null or t.created_at >= p_from)
      and (p_to is null or t.created_at < p_to)
      and (p_q is null or concat_ws(' ', left(t.id::text, 8), t.question, t.place_label, a.name,
        replace(t.status, '_', ' '), eyes_shown_usd(t.bounty_cents), eyes_shown_at(t.created_at, p_tz))
        ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc
  limit least(p_limit, 200)
$$;

drop function eyes_ledger_page(integer, text, text, timestamptz, uuid);
create function eyes_ledger_page(
  p_limit integer, p_q text, p_type text, p_before_at timestamptz, p_before_id uuid,
  p_tz text default null, p_from timestamptz default null, p_to timestamptz default null
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
      and (p_from is null or l.created_at >= p_from)
      and (p_to is null or l.created_at < p_to)
      and (p_q is null or concat_ws(' ', eyes_shown_at(l.created_at, p_tz),
        coalesce('{"topup":"Top-up","escrow":"Escrow","release":"Release","refund":"Refund","payout":"Payout",
          "fee":"Fee"}'::jsonb ->> l.type, l.type),
        eyes_shown_usd(l.amount_cents), t.place_label, left(l.task_id::text, 8)) ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc
  limit least(p_limit, 200)
$$;

revoke execute on function eyes_shown_at(timestamptz, text) from public;
revoke execute on function eyes_shown_usd(bigint) from public;
revoke execute on function eyes_events_page(integer, text, text, text, uuid, timestamptz, bigint, timestamptz, bigint, text, timestamptz, timestamptz) from public;
revoke execute on function eyes_tasks_page(integer, text, text, timestamptz, uuid, text, timestamptz, timestamptz) from public;
revoke execute on function eyes_ledger_page(integer, text, text, timestamptz, uuid, text, timestamptz, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_shown_at(timestamptz, text) from %I', v_role);
    execute format('revoke execute on function eyes_shown_usd(bigint) from %I', v_role);
    execute format('revoke execute on function eyes_events_page(integer, text, text, text, uuid, timestamptz, bigint, timestamptz, bigint, text, timestamptz, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_tasks_page(integer, text, text, timestamptz, uuid, text, timestamptz, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_ledger_page(integer, text, text, timestamptz, uuid, text, timestamptz, timestamptz) from %I', v_role);
  end loop;
end $$;
