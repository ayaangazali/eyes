-- Disputes (T6.20, ADR-026): the photo check no longer judges answers (ADR-025), so a wrong or fake
-- answer reaches ops as a "dispute" support ticket. Ops either confirms fraud (refund the agent,
-- reverse the worker's transfer, ban the worker) or rejects the dispute (the worker keeps the pay).

alter table workers add column banned boolean not null default false;

alter table tickets drop constraint tickets_kind_check;
alter table tickets add constraint tickets_kind_check check (kind in ('manual_review', 'dispute'));
alter table tickets add column dispute_status text
  check (dispute_status in ('open', 'upheld', 'rejected'));
-- What the worker's Stripe transfer reversal left unpaid; null when nothing is owed.
alter table tickets add column reversal_owed_cents bigint check (reversal_owed_cents > 0);
alter table tickets add constraint tickets_dispute_status check ((kind = 'dispute') = (dispute_status is not null));
drop index tickets_one_open_per_task;
create unique index tickets_one_open_per_task on tickets (task_id, kind) where status = 'open';

-- A refund to the agent after the bounty was already released to the worker. Kept apart from
-- 'refund' so escrow math (escrow - release - fee - refund) stays exact.
alter table ledger drop constraint ledger_type_check;
alter table ledger add constraint ledger_type_check
  check (type in ('topup','escrow','release','refund','payout','fee','fraud_refund'));

-- HELP tickets never touch a dispute ticket on the same task.
create or replace function eyes_open_ticket(p_worker_id uuid, p_message text, p_now timestamptz)
returns setof tickets language plpgsql as $$
declare
  v_task_id uuid;
  v_ticket tickets;
begin
  select t.id into v_task_id
  from tasks t
  join lateral (
    select created_at from submissions s where s.task_id = t.id and s.worker_id = p_worker_id
    order by created_at desc limit 1
  ) s on true
  where t.claimed_by = p_worker_id and t.status = 'needs_review' and s.created_at >= p_now - interval '48 hours'
  order by s.created_at desc
  limit 1;
  if v_task_id is null then
    return;
  end if;
  update tickets set message = concat_ws(E'\n', nullif(message, ''), p_message)
  where task_id = v_task_id and status = 'open' and kind = 'manual_review'
  returning * into v_ticket;
  if not found then
    insert into tickets (worker_id, task_id, message, created_at)
    values (p_worker_id, v_task_id, p_message, p_now)
    returning * into v_ticket;
  end if;
  return next v_ticket;
end $$;

create or replace function eyes_append_ticket(p_worker_id uuid, p_message text)
returns setof tickets language sql as $$
  update tickets set message = concat_ws(E'\n', nullif(message, ''), p_message)
  where id = (
    select id from tickets where worker_id = p_worker_id and status = 'open' and kind = 'manual_review'
    order by created_at desc limit 1
  )
  returning *
$$;

-- The release/refund/close ticket actions are for HELP tickets only; disputes use the two below.
create or replace function eyes_resolve_ticket(p_ticket_id bigint, p_note text, p_now timestamptz)
returns setof tickets language plpgsql as $$
declare
  v_ticket tickets;
begin
  update tickets set status = 'resolved', resolved_at = p_now, note = p_note
  where id = p_ticket_id and status = 'open' and kind = 'manual_review'
  returning * into v_ticket;
  if not found then
    raise exception 'eyes:invalid_input %', json_build_object(
      'ticket_id', p_ticket_id,
      'issues', json_build_array(json_build_object('path', 'ticket_id', 'message', 'No open review ticket with this id.'))
    );
  end if;
  return next v_ticket;
end $$;

-- The agent disputes an answer: the task goes to 'disputed' (as before) and a dispute ticket opens.
create or replace function eyes_dispute(p_agent_id uuid, p_task_id uuid, p_reason text)
returns setof tasks language plpgsql as $$
declare
  v_task tasks;
  v_now timestamptz := now();
begin
  select * into v_task from tasks where id = p_task_id and agent_id = p_agent_id for update;
  if not found then
    raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id);
  end if;
  if v_task.status not in ('verified', 'paid', 'needs_review') then
    raise exception 'eyes:task_not_disputable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  update tasks set status = 'disputed', dispute_reason = p_reason where id = p_task_id returning * into v_task;
  insert into tickets (worker_id, task_id, kind, dispute_status, message, created_at)
  values (v_task.claimed_by, p_task_id, 'dispute', 'open', p_reason, v_now)
  on conflict (task_id, kind) where status = 'open'
  do update set message = concat_ws(E'\n', nullif(tickets.message, ''), excluded.message);
  return next v_task;
end $$;

-- Confirm fraud, once: refund the agent bounty + fee, ban the worker, close the ticket.
-- A second call returns the ticket with already = true and moves no money. The caller reverses
-- the Stripe transfer (transfer_id) and records the outcome with eyes_record_reversal.
create function eyes_confirm_fraud(p_ticket_id bigint, p_note text, p_now timestamptz)
returns table (ticket tickets, already boolean, refund_cents bigint, transfer_id text, payout_cents bigint)
language plpgsql as $$
declare
  v_ticket tickets;
  v_task tasks;
  v_released boolean;
begin
  select * into v_ticket from tickets where id = p_ticket_id and kind = 'dispute' for update;
  if not found then
    raise exception 'eyes:invalid_input %', json_build_object(
      'ticket_id', p_ticket_id,
      'issues', json_build_array(json_build_object('path', 'ticket_id', 'message', 'No dispute ticket with this id.'))
    );
  end if;
  if v_ticket.dispute_status <> 'open' then
    return query select v_ticket, true, null::bigint, null::text, null::bigint;
    return;
  end if;
  select * into v_task from tasks where id = v_ticket.task_id for update;
  v_released := exists (select 1 from ledger where task_id = v_task.id and type = 'release');
  -- Already refunded (ops refunded the task by hand first): ban and close without paying twice.
  if v_task.status <> 'refunded' then
    insert into ledger (agent_id, task_id, type, amount_cents, created_at)
    values (v_task.agent_id, v_task.id, case when v_released then 'fraud_refund' else 'refund' end,
      v_task.bounty_cents + v_task.fee_cents, p_now);
    update agents set balance_cents = balance_cents + v_task.bounty_cents + v_task.fee_cents
    where id = v_task.agent_id;
  end if;
  update tasks set status = 'refunded',
    dispute_reason = concat_ws(E'\n', dispute_reason, 'fraud confirmed: ' || p_note)
  where id = v_task.id;
  delete from worker_location_tokens where worker_id = v_task.claimed_by;
  update workers set banned = true, opted_in = false, available = false,
    lat = null, lng = null, location_at = null, location_accuracy_m = null, location_source = null,
    location_token_hash = null
  where id = v_task.claimed_by;
  update tickets set status = 'resolved', resolved_at = p_now, note = p_note, dispute_status = 'upheld'
  where id = p_ticket_id returning * into v_ticket;
  return query
  select v_ticket, false, case when v_task.status = 'refunded' then 0 else v_task.bounty_cents + v_task.fee_cents end::bigint,
    (select stripe_ref from ledger where task_id = v_task.id and type = 'payout'),
    (select amount_cents from ledger where task_id = v_task.id and type = 'payout');
end $$;

create function eyes_record_reversal(p_ticket_id bigint, p_owed_cents bigint)
returns setof tickets language sql as $$
  update tickets set reversal_owed_cents = nullif(p_owed_cents, 0) where id = p_ticket_id returning *
$$;

-- Reject a dispute, once: close the ticket. The caller releases the task to the worker.
create function eyes_reject_dispute(p_ticket_id bigint, p_note text, p_now timestamptz)
returns table (ticket tickets, already boolean) language plpgsql as $$
declare
  v_ticket tickets;
begin
  select * into v_ticket from tickets where id = p_ticket_id and kind = 'dispute' for update;
  if not found then
    raise exception 'eyes:invalid_input %', json_build_object(
      'ticket_id', p_ticket_id,
      'issues', json_build_array(json_build_object('path', 'ticket_id', 'message', 'No dispute ticket with this id.'))
    );
  end if;
  if v_ticket.dispute_status <> 'open' then
    return query select v_ticket, true;
    return;
  end if;
  update tickets set status = 'resolved', resolved_at = p_now, note = p_note, dispute_status = 'rejected'
  where id = p_ticket_id returning * into v_ticket;
  return query select v_ticket, false;
end $$;

-- The newest dispute on a task, for get_task.
create function eyes_task_dispute(p_task_id uuid)
returns setof tickets language sql stable as $$
  select * from tickets where task_id = p_task_id and kind = 'dispute' order by created_at desc limit 1
$$;

-- A banned worker cannot opt back in (START) with the same phone.
create or replace function eyes_set_worker_opt_in(p_phone text, p_opted_in boolean)
returns setof workers language plpgsql as $$
begin
  if not p_opted_in then
    delete from worker_location_tokens t using workers w where w.phone = p_phone and t.worker_id = w.id;
  end if;
  return query
  update workers set
    opted_in = p_opted_in,
    available = p_opted_in,
    lat = case when p_opted_in then lat end,
    lng = case when p_opted_in then lng end,
    location_at = case when p_opted_in then location_at end,
    location_accuracy_m = case when p_opted_in then location_accuracy_m end,
    location_source = case when p_opted_in then location_source end,
    location_token_hash = null
  where phone = p_phone and not (p_opted_in and banned)
  returning *;
end $$;

-- Ops dashboard tickets gain the dispute fields and whether the worker is banned.
create or replace function eyes_tickets(p_limit integer)
returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select k.id, k.worker_id, k.task_id, k.kind, k.status, k.message, k.created_at, k.resolved_at, k.note,
      k.dispute_status, k.reversal_owed_cents, w.banned as worker_banned,
      t.question, t.place_label, t.status as task_status, t.bounty_cents, t.fee_cents, t.lat, t.lng, t.radius_m,
      s.photo_url, s.answer_text, s.answer_bool, s.gps_ok, s.fresh_ok, s.vision_ok, s.vision_reason, s.confidence,
      s.lat as submission_lat, s.lng as submission_lng, s.created_at as submitted_at
    from tickets k
    join tasks t on t.id = k.task_id
    join workers w on w.id = k.worker_id
    left join lateral (
      select * from submissions sub where sub.task_id = k.task_id order by sub.created_at desc limit 1
    ) s on true
    order by k.status = 'open' desc, k.created_at desc
    limit p_limit
  ) f
$$;

revoke execute on function eyes_confirm_fraud(bigint, text, timestamptz) from public;
revoke execute on function eyes_record_reversal(bigint, bigint) from public;
revoke execute on function eyes_reject_dispute(bigint, text, timestamptz) from public;
revoke execute on function eyes_task_dispute(uuid) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_confirm_fraud(bigint, text, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_record_reversal(bigint, bigint) from %I', v_role);
    execute format('revoke execute on function eyes_reject_dispute(bigint, text, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_task_dispute(uuid) from %I', v_role);
  end loop;
end $$;
