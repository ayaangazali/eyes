-- Ops event log: every request and state change, already redacted by the app (or written by the
-- triggers below, which only copy ids, statuses and amounts). ponytail: no pruning; add a
-- `delete from events where at < now() - interval '30 days'` job if the table ever gets big.
create table events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  task_id uuid,
  summary text not null,
  data jsonb not null default '{}'::jsonb
);
create index events_at on events (at desc, id desc);
create index events_kind_at on events (kind, at desc);
create index events_task on events (task_id, at desc) where task_id is not null;

-- Support tickets: a worker asks for a manual review of a held answer by texting HELP.
-- The id is the ticket number the worker sees.
create table tickets (
  id bigint generated always as identity primary key,
  worker_id uuid not null references workers(id),
  task_id uuid not null references tasks(id),
  kind text not null default 'manual_review' check (kind in ('manual_review')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  message text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  note text,
  check ((status = 'resolved') = (resolved_at is not null))
);
create unique index tickets_one_open_per_task on tickets (task_id) where status = 'open';
create index tickets_worker_open on tickets (worker_id, created_at desc) where status = 'open';

create function eyes_task_event() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into events (kind, level, task_id, summary, data)
    values (
      'task',
      case when new.status in ('needs_review', 'disputed') then 'warn' else 'info' end,
      new.id,
      case when tg_op = 'INSERT' then new.status else old.status || ' -> ' || new.status end,
      jsonb_build_object('from', case when tg_op = 'INSERT' then null else old.status end, 'to', new.status,
        'bounty_cents', new.bounty_cents)
    );
  end if;
  return new;
end $$;
create trigger tasks_event after insert or update of status on tasks
  for each row execute function eyes_task_event();

create function eyes_ledger_event() returns trigger language plpgsql as $$
begin
  insert into events (kind, task_id, summary, data)
  values ('ledger', new.task_id, new.type || ' ' || new.amount_cents || 'c',
    jsonb_build_object('type', new.type, 'amount_cents', new.amount_cents));
  return new;
end $$;
create trigger ledger_event after insert on ledger
  for each row execute function eyes_ledger_event();

create function eyes_ticket_event() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into events (kind, level, task_id, summary, data)
    values ('ticket', case when new.status = 'open' then 'warn' else 'info' end, new.task_id,
      'ticket #' || new.id || ' ' || new.status, jsonb_build_object('ticket_id', new.id, 'kind', new.kind));
  end if;
  return new;
end $$;
create trigger tickets_event after insert or update of status on tickets
  for each row execute function eyes_ticket_event();

create function eyes_log_events(p_events jsonb)
returns setof integer language sql as $$
  with ins as (
    insert into events (at, kind, level, task_id, summary, data)
    select coalesce(e.at, now()), e.kind, coalesce(e.level, 'info'), e.task_id, e.summary, coalesce(e.data, '{}'::jsonb)
    from jsonb_to_recordset(p_events) as e(at timestamptz, kind text, level text, task_id uuid, summary text, data jsonb)
    returning 1
  )
  select count(*)::integer from ins
$$;

create function eyes_events(p_limit integer, p_kind text, p_level text, p_q text, p_task_id uuid, p_before bigint)
returns setof events language sql stable as $$
  select * from events
  where (p_kind is null or kind = p_kind)
    and (p_level is null or level = p_level)
    and (p_task_id is null or task_id = p_task_id)
    and (p_before is null or id < p_before)
    and (p_q is null or summary ilike '%' || p_q || '%' or data::text ilike '%' || p_q || '%')
  order by id desc
  limit least(p_limit, 500)
$$;

-- Opens a manual_review ticket for the worker's newest needs_review task answered in the last 48 h,
-- or appends to the open ticket on that task. No row when there is no such task.
create function eyes_open_ticket(p_worker_id uuid, p_message text, p_now timestamptz)
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
  where task_id = v_task_id and status = 'open'
  returning * into v_ticket;
  if not found then
    insert into tickets (worker_id, task_id, message, created_at)
    values (p_worker_id, v_task_id, p_message, p_now)
    returning * into v_ticket;
  end if;
  return next v_ticket;
end $$;

-- Appends a free-text reply to the worker's newest open ticket. No row when none is open.
create function eyes_append_ticket(p_worker_id uuid, p_message text)
returns setof tickets language sql as $$
  update tickets set message = concat_ws(E'\n', nullif(message, ''), p_message)
  where id = (
    select id from tickets where worker_id = p_worker_id and status = 'open' order by created_at desc limit 1
  )
  returning *
$$;

create function eyes_resolve_ticket(p_ticket_id bigint, p_note text, p_now timestamptz)
returns setof tickets language plpgsql as $$
declare
  v_ticket tickets;
begin
  update tickets set status = 'resolved', resolved_at = p_now, note = p_note
  where id = p_ticket_id and status = 'open'
  returning * into v_ticket;
  if not found then
    raise exception 'eyes:invalid_input %', json_build_object(
      'ticket_id', p_ticket_id,
      'issues', json_build_array(json_build_object('path', 'ticket_id', 'message', 'No open ticket with this id.'))
    );
  end if;
  return next v_ticket;
end $$;

-- Tickets for the ops dashboard, open first. Carries the submission's position only so the server
-- can compute the worker's distance; the server drops it before anything leaves the process.
create function eyes_tickets(p_limit integer)
returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select k.id, k.worker_id, k.task_id, k.kind, k.status, k.message, k.created_at, k.resolved_at, k.note,
      t.question, t.place_label, t.status as task_status, t.bounty_cents, t.fee_cents, t.lat, t.lng, t.radius_m,
      s.photo_url, s.answer_text, s.answer_bool, s.gps_ok, s.fresh_ok, s.vision_ok, s.vision_reason, s.confidence,
      s.lat as submission_lat, s.lng as submission_lng, s.created_at as submitted_at
    from tickets k
    join tasks t on t.id = k.task_id
    left join lateral (
      select * from submissions sub where sub.task_id = k.task_id order by sub.created_at desc limit 1
    ) s on true
    order by k.status = 'open' desc, k.created_at desc
    limit p_limit
  ) f
$$;

revoke execute on function eyes_log_events(jsonb) from public;
revoke execute on function eyes_events(integer, text, text, text, uuid, bigint) from public;
revoke execute on function eyes_open_ticket(uuid, text, timestamptz) from public;
revoke execute on function eyes_append_ticket(uuid, text) from public;
revoke execute on function eyes_resolve_ticket(bigint, text, timestamptz) from public;
revoke execute on function eyes_tickets(integer) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table events, tickets from %I', v_role);
    execute format('revoke execute on function eyes_log_events(jsonb) from %I', v_role);
    execute format('revoke execute on function eyes_events(integer, text, text, text, uuid, bigint) from %I', v_role);
    execute format('revoke execute on function eyes_open_ticket(uuid, text, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_append_ticket(uuid, text) from %I', v_role);
    execute format('revoke execute on function eyes_resolve_ticket(bigint, text, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_tickets(integer) from %I', v_role);
  end loop;
end $$;

-- Ops dashboard sign-in: only people on ops_allowlist get a one-time code by text or email.
-- ops_codes keeps one live code per identifier, as an HMAC only; the app counts every guess
-- (eyes_ops_code_attempt) before it compares, so concurrent guesses cannot pass the limit.
create table ops_allowlist (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('phone', 'email')),
  value text not null unique,
  added_by text not null,
  added_at timestamptz not null default now()
);
insert into ops_allowlist (kind, value, added_by) values
  ('phone', '+15109009898', 'seed'),
  ('email', 'jerry@xiao.sh', 'seed');

create table ops_codes (
  identifier text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create function eyes_ops_allowlist()
returns setof ops_allowlist language sql stable as $$
  select * from ops_allowlist order by added_at, value
$$;

create function eyes_ops_allowlist_add(p_kind text, p_value text, p_added_by text)
returns setof ops_allowlist language sql as $$
  insert into ops_allowlist (kind, value, added_by) values (p_kind, p_value, p_added_by)
  on conflict (value) do nothing;
  select * from ops_allowlist where value = p_value;
$$;

create function eyes_ops_allowlist_remove(p_id uuid)
returns setof ops_allowlist language sql as $$
  delete from ops_allowlist where id = p_id returning *
$$;

create function eyes_ops_code_put(p_identifier text, p_code_hash text, p_expires_at timestamptz)
returns setof ops_codes language sql as $$
  insert into ops_codes (identifier, code_hash, expires_at) values (p_identifier, p_code_hash, p_expires_at)
  on conflict (identifier) do update
    set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = now()
  returning *
$$;

create function eyes_ops_code_attempt(p_identifier text)
returns setof ops_codes language sql as $$
  update ops_codes set attempts = attempts + 1 where identifier = p_identifier returning *
$$;

create function eyes_ops_code_delete(p_identifier text)
returns setof ops_codes language sql as $$
  delete from ops_codes where identifier = p_identifier returning *
$$;

revoke execute on function eyes_ops_allowlist() from public;
revoke execute on function eyes_ops_allowlist_add(text, text, text) from public;
revoke execute on function eyes_ops_allowlist_remove(uuid) from public;
revoke execute on function eyes_ops_code_put(text, text, timestamptz) from public;
revoke execute on function eyes_ops_code_attempt(text) from public;
revoke execute on function eyes_ops_code_delete(text) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table ops_allowlist, ops_codes from %I', v_role);
    execute format('revoke execute on function eyes_ops_allowlist() from %I', v_role);
    execute format('revoke execute on function eyes_ops_allowlist_add(text, text, text) from %I', v_role);
    execute format('revoke execute on function eyes_ops_allowlist_remove(uuid) from %I', v_role);
    execute format('revoke execute on function eyes_ops_code_put(text, text, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_ops_code_attempt(text) from %I', v_role);
    execute format('revoke execute on function eyes_ops_code_delete(text) from %I', v_role);
  end loop;
end $$;
