-- Classifier feedback stays in Support, including refusals before a task or worker exists.
alter table tickets alter column worker_id drop not null;
alter table tickets alter column task_id drop not null;
alter table tickets drop constraint tickets_kind_check;
alter table tickets add constraint tickets_kind_check
  check (kind in ('manual_review', 'dispute', 'classifier_feedback'));
alter table tickets add column agent_id uuid references agents(id);
alter table tickets add column request jsonb;
alter table tickets add column reported_context jsonb;
alter table tickets add column request_fingerprint text;
alter table tickets add column report_key text;
alter table tickets add column classifier_decision text check (classifier_decision in ('approved', 'rejected'));
alter table tickets add column decision_by text;
alter table tickets add column decision_at timestamptz;
alter table tickets add column approval_expires_at timestamptz;
alter table tickets add column consumed_task_id uuid references tasks(id);
alter table tickets add constraint tickets_classifier_fields check (
  (kind <> 'classifier_feedback' and worker_id is not null and task_id is not null)
  or (kind = 'classifier_feedback' and agent_id is not null and worker_id is null
    and request is not null and reported_context is not null
    and jsonb_typeof(request) = 'object' and jsonb_typeof(reported_context) = 'object'
    and request_fingerprint is not null and report_key is not null
    and length(report_key) between 1 and 128
    and length(request_fingerprint) = 64
    and length(request::text) <= 8000 and length(reported_context::text) <= 20000)
);
alter table tickets add constraint tickets_classifier_decision check (
  kind <> 'classifier_feedback' or
  ((status = 'open' and classifier_decision is null and decision_at is null and decision_by is null)
    or (status = 'resolved' and classifier_decision is not null and decision_at is not null and decision_by is not null))
);
create unique index tickets_report_key on tickets(agent_id, report_key) where kind = 'classifier_feedback';
-- Distinct refusal cards may reference the same existing task; HELP/dispute uniqueness is unchanged.
drop index tickets_one_open_per_task;
create unique index tickets_one_open_per_task on tickets(task_id, kind)
  where status = 'open' and kind in ('manual_review', 'dispute');

-- Preserve the dispute writer's conflict target after limiting that index to legacy ticket kinds.
create or replace function eyes_dispute(p_agent_id uuid, p_task_id uuid, p_reason text)
returns setof tasks language plpgsql as $$
declare v_task tasks; v_now timestamptz := now();
begin
  select * into v_task from tasks where id = p_task_id and agent_id = p_agent_id for update;
  if not found then raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id); end if;
  if v_task.status not in ('verified', 'paid', 'needs_review') then
    raise exception 'eyes:task_not_disputable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  update tasks set status = 'disputed', dispute_reason = p_reason where id = p_task_id returning * into v_task;
  insert into tickets(worker_id, task_id, kind, dispute_status, message, created_at)
  values(v_task.claimed_by, p_task_id, 'dispute', 'open', p_reason, v_now)
  on conflict(task_id, kind) where status = 'open' and kind in ('manual_review', 'dispute')
  do update set message = concat_ws(E'\n', nullif(tickets.message, ''), excluded.message);
  return next v_task;
end $$;

create function eyes_report_classifier(
  p_agent_id uuid, p_request jsonb, p_context jsonb, p_fingerprint text,
  p_key text, p_task_id uuid, p_now timestamptz
) returns table(ticket tickets, created boolean) language plpgsql as $$
declare v_ticket tickets;
begin
  if p_task_id is not null and not exists (
    select 1 from tasks where id = p_task_id and agent_id = p_agent_id
  ) then
    raise exception 'eyes:task_not_found';
  end if;
  insert into tickets(agent_id, task_id, kind, message, request, reported_context,
    request_fingerprint, report_key, created_at)
  values(p_agent_id, p_task_id, 'classifier_feedback',
    'Client-reported classifier feedback (untrusted): ' || (p_request ->> 'question'),
    p_request, p_context, p_fingerprint, p_key, p_now)
  on conflict (agent_id, report_key) where kind = 'classifier_feedback' do nothing
  returning * into v_ticket;
  if found then
    return query select v_ticket, true;
    return;
  end if;
  select * into v_ticket from tickets
    where agent_id = p_agent_id and report_key = p_key and kind = 'classifier_feedback';
  if v_ticket.request_fingerprint <> p_fingerprint or v_ticket.task_id is distinct from p_task_id then
    raise exception 'eyes:idempotency_conflict';
  end if;
  return query select v_ticket, false;
end $$;

create function eyes_classifier_report(p_agent_id uuid, p_ticket_id bigint)
returns setof tickets language sql stable as $$
  select * from tickets where id = p_ticket_id and agent_id = p_agent_id and kind = 'classifier_feedback'
$$;

create function eyes_decide_classifier(
  p_ticket_id bigint, p_decision text, p_note text, p_operator text, p_now timestamptz
) returns table(ticket tickets, already boolean) language plpgsql as $$
declare v_ticket tickets;
begin
  if p_decision not in ('approved', 'rejected') or length(p_note) > 500
    or (p_decision = 'rejected' and length(trim(p_note)) = 0)
    or length(trim(p_operator)) = 0 then
    raise exception 'eyes:invalid_input';
  end if;
  select * into v_ticket from tickets where id = p_ticket_id and kind = 'classifier_feedback' for update;
  if not found then raise exception 'eyes:invalid_input'; end if;
  if v_ticket.status <> 'open' then
    return query select v_ticket, true;
    return;
  end if;
  update tickets set status = 'resolved', resolved_at = p_now, classifier_decision = p_decision,
    decision_by = p_operator, decision_at = p_now, note = p_note,
    approval_expires_at = case when p_decision = 'approved' then p_now + interval '24 hours' end
  where id = p_ticket_id returning * into v_ticket;
  insert into events(kind, level, summary, data, task_id, at)
  values('ops', 'info', 'classifier ticket #' || p_ticket_id || ' ' || p_decision || ' by ' || p_operator,
    jsonb_build_object('ticket_id', p_ticket_id, 'action', p_decision, 'operator', p_operator,
      'request_fingerprint', v_ticket.request_fingerprint, 'note', p_note), v_ticket.task_id, p_now);
  return query select v_ticket, false;
end $$;

-- Lock the approval and post through the existing money/idempotency transaction. A failed post
-- leaves the approval unused; a successful one can only return that same task on retries.
create function eyes_post_reviewed_task(
  p_ticket_id bigint, p_fingerprint text,
  p_agent_id uuid, p_question text, p_task_type text, p_place_label text,
  p_lat double precision, p_lng double precision, p_radius_m integer,
  p_bounty_cents bigint, p_fee_cents bigint, p_require_photo boolean,
  p_deadline_minutes integer, p_idempotency_key text, p_worker_ids uuid[], p_now timestamptz
) returns table(task tasks, created boolean, workers_notified integer) language plpgsql as $$
declare v_ticket tickets; v_post record;
begin
  select * into v_ticket from tickets where id = p_ticket_id and agent_id = p_agent_id
    and kind = 'classifier_feedback' for update;
  if not found or v_ticket.request_fingerprint <> p_fingerprint
    or v_ticket.classifier_decision is distinct from 'approved'
    or (v_ticket.consumed_task_id is null and v_ticket.approval_expires_at <= p_now)
    or v_ticket.request ->> 'idempotency_key' is distinct from p_idempotency_key then
    raise exception 'eyes:unsafe_task';
  end if;
  select * into v_post from eyes_post_task(p_agent_id, p_question, p_task_type, p_place_label,
    p_lat, p_lng, p_radius_m, p_bounty_cents, p_fee_cents, p_require_photo,
    p_deadline_minutes, p_idempotency_key, p_worker_ids, p_now);
  if v_ticket.consumed_task_id is not null and v_ticket.consumed_task_id <> (v_post.task).id then
    raise exception 'eyes:unsafe_task';
  end if;
  update tickets set consumed_task_id = (v_post.task).id where id = p_ticket_id;
  return query select v_post.task, v_post.created, v_post.workers_notified;
end $$;

create or replace function eyes_tickets_page(
  p_limit integer, p_q text, p_state text, p_kind text, p_before_at timestamptz, p_before_id bigint
) returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select k.id, k.worker_id, k.task_id, k.kind, k.status, k.message, k.created_at, k.resolved_at, k.note,
      k.dispute_status, k.reversal_owed_cents, w.banned as worker_banned,
      k.agent_id, k.request, k.reported_context, k.request_fingerprint,
      k.decision_by, k.decision_at, k.approval_expires_at, k.consumed_task_id,
      case when k.kind <> 'classifier_feedback' then null
        when k.consumed_task_id is not null then 'consumed'
        when k.classifier_decision = 'approved' and k.approval_expires_at <= now() then 'expired'
        else coalesce(k.classifier_decision, 'open') end as classifier_status,
      coalesce(k.request ->> 'question', t.question) as question,
      coalesce(case when jsonb_typeof(k.request -> 'location') = 'string'
        then k.request ->> 'location' else (k.request -> 'location')::text end, t.place_label) as place_label,
      t.status as task_status,
      coalesce(((k.request ->> 'bounty_usd')::numeric * 100)::bigint, t.bounty_cents) as bounty_cents,
      t.fee_cents, t.lat, t.lng, t.radius_m,
      s.photo_url, s.answer_text, s.answer_bool, s.gps_ok, s.fresh_ok, s.vision_ok, s.vision_reason, s.confidence,
      s.lat as submission_lat, s.lng as submission_lng, s.created_at as submitted_at,
      count(*) over () as total
    from tickets k
    left join tasks t on t.id = k.task_id
    left join workers w on w.id = k.worker_id
    left join lateral (
      select * from submissions sub where sub.task_id = k.task_id order by sub.created_at desc limit 1
    ) s on true
    where (p_kind is null or k.kind = p_kind)
      and (p_state is null or (case when k.kind = 'dispute' then k.dispute_status = 'open' else k.status = 'open' end)
        = (p_state = 'open'))
      and (p_q is null or concat_ws(' ', '#' || k.id, coalesce(k.request ->> 'question', t.question),
        case k.kind when 'dispute' then 'Dispute' when 'classifier_feedback' then 'Classifier feedback' else 'Help' end,
        coalesce(k.classifier_decision, k.dispute_status, k.status), k.message, t.place_label,
        k.request ->> 'location', eyes_shown_usd(t.bounty_cents), left(k.task_id::text, 8)) ilike '%' || p_q || '%')
  ) f
  where p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id)
  order by f.created_at desc, f.id desc limit least(p_limit, 200)
$$;

-- Preserve the legacy feed's open-first ordering without a paged-list window.
create or replace function eyes_tickets(p_limit integer)
returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select k.id, k.worker_id, k.task_id, k.kind, k.status, k.message, k.created_at, k.resolved_at, k.note,
      k.agent_id, k.request, k.reported_context, k.request_fingerprint,
      k.decision_by, k.decision_at, k.approval_expires_at,
      coalesce(k.request ->> 'question', t.question) as question,
      coalesce(k.request ->> 'location', t.place_label) as place_label,
      t.status as task_status, t.bounty_cents, t.fee_cents, t.lat, t.lng, t.radius_m,
      s.photo_url, s.answer_text, s.answer_bool, s.gps_ok, s.fresh_ok, s.vision_ok, s.vision_reason, s.confidence,
      s.lat as submission_lat, s.lng as submission_lng, s.created_at as submitted_at
    from tickets k left join tasks t on t.id = k.task_id
    left join lateral (
      select * from submissions sub where sub.task_id = k.task_id order by sub.created_at desc limit 1
    ) s on true
    order by k.status = 'open' desc, k.created_at desc
    limit p_limit
  ) f
$$;

-- Check ticket kind/task before the legacy HTTP handler can release or refund money.
create function eyes_manual_ticket(p_ticket_id bigint, p_task_id uuid)
returns setof tickets language sql stable as $$
  select * from tickets where id = p_ticket_id and task_id = p_task_id and kind = 'manual_review'
$$;
revoke execute on function eyes_manual_ticket(bigint, uuid) from public;

revoke execute on function eyes_report_classifier(uuid, jsonb, jsonb, text, text, uuid, timestamptz) from public;
revoke execute on function eyes_classifier_report(uuid, bigint) from public;
revoke execute on function eyes_decide_classifier(bigint, text, text, text, timestamptz) from public;
revoke execute on function eyes_post_reviewed_task(bigint, text, uuid, text, text, text, double precision, double precision, integer, bigint, bigint, boolean, integer, text, uuid[], timestamptz) from public;
do $$
declare v_role text; v_fn text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    foreach v_fn in array array[
      'eyes_manual_ticket(bigint,uuid)',
      'eyes_report_classifier(uuid,jsonb,jsonb,text,text,uuid,timestamptz)',
      'eyes_classifier_report(uuid,bigint)',
      'eyes_decide_classifier(bigint,text,text,text,timestamptz)',
      'eyes_post_reviewed_task(bigint,text,uuid,text,text,text,double precision,double precision,integer,bigint,bigint,boolean,integer,text,uuid[],timestamptz)'
    ] loop execute format('revoke execute on function %s from %I', v_fn, v_role); end loop;
  end loop;
end $$;
