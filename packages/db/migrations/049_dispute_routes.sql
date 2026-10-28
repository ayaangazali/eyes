-- Worker and owner dispute routes (ADR-050). A worker contests an owner's dispute: one manual_review
-- ticket marked appeal, so ops reviews it with the existing HELP actions. One appeal per task, ever.
alter table tickets add column appeal boolean not null default false;

create function eyes_worker_dispute(p_worker_id uuid, p_task_id uuid, p_reason text)
returns setof tickets language plpgsql as $$
declare
  v_task tasks;
  v_dispute tickets;
  v_ticket tickets;
begin
  -- Worker lock first, then task, as eyes_dispute does.
  perform 1 from workers where id = p_worker_id for update;
  select * into v_task from tasks where id = p_task_id and claimed_by = p_worker_id for update;
  if not found then
    raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id);
  end if;
  select * into v_dispute from tickets where task_id = p_task_id and kind = 'dispute'
  order by created_at desc limit 1;
  if not found or v_dispute.dispute_status = 'rejected'
    or exists (select 1 from tickets where task_id = p_task_id and appeal) then
    raise exception 'eyes:task_not_disputable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  insert into tickets (worker_id, task_id, kind, appeal, message, created_at)
  values (p_worker_id, p_task_id, 'manual_review', true, p_reason, clock_timestamp())
  on conflict (task_id, kind) where status = 'open' and kind in ('manual_review', 'dispute')
  do update set appeal = true, message = concat_ws(E'\n', nullif(tickets.message, ''), excluded.message)
  returning * into v_ticket;
  return next v_ticket;
end $$;

-- open: the owner's dispute waits. in_review: the worker contested it and ops has not closed that.
-- stands: ops rejected the dispute. upheld: ops confirmed it and refunded the owner.
create function eyes_dispute_states(p_task_ids uuid[])
returns table (task_id uuid, state text) language sql stable as $$
  select d.task_id,
    case
      when exists (select 1 from tickets a where a.task_id = d.task_id and a.appeal and a.status = 'open')
        then 'in_review'
      when d.dispute_status = 'rejected' then 'stands'
      else d.dispute_status
    end
  from (
    select distinct on (k.task_id) k.task_id, k.dispute_status from tickets k
    where k.task_id = any (p_task_ids) and k.kind = 'dispute'
    order by k.task_id, k.created_at desc
  ) d
$$;

revoke execute on function eyes_worker_dispute(uuid, uuid, text) from public;
revoke execute on function eyes_dispute_states(uuid[]) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_worker_dispute(uuid, uuid, text) from %I', v_role);
    execute format('revoke execute on function eyes_dispute_states(uuid[]) from %I', v_role);
  end loop;
end $$;
