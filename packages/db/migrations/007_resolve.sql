create or replace function eyes_payouts_due(p_account_id text, p_limit integer)
returns table (task tasks, worker workers) language sql stable as $$
  select t, w
  from tasks t join workers w on w.id = t.claimed_by
  where t.status = 'verified' and w.stripe_account_id is not null
    and (p_account_id is null or w.stripe_account_id = p_account_id)
  order by t.created_at
  limit p_limit
$$;

create or replace function eyes_resolve_task(p_task_id uuid, p_decision text, p_note text, p_now timestamptz)
returns setof tasks language plpgsql as $$
declare
  v_task tasks;
  v_released boolean;
  v_why text;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id);
  end if;
  v_released := exists (select 1 from ledger where task_id = p_task_id and type = 'release');
  if v_task.status not in ('needs_review', 'disputed') then
    v_why := 'Only needs_review or disputed tasks can be resolved; this task is ' || v_task.status || '.';
  elsif p_decision = 'refund' and v_released then
    v_why := 'The bounty was already released to the worker before the dispute, so only release is possible.';
  end if;
  if v_why is not null then
    raise exception 'eyes:invalid_input %', json_build_object(
      'task_id', p_task_id,
      'status', v_task.status,
      'issues', json_build_array(json_build_object('path', 'task_id', 'message', v_why))
    );
  end if;

  if p_decision = 'refund' then
    insert into ledger (agent_id, task_id, type, amount_cents, created_at)
    values (v_task.agent_id, p_task_id, 'refund', v_task.bounty_cents + v_task.fee_cents, p_now);
    update agents set balance_cents = balance_cents + v_task.bounty_cents + v_task.fee_cents
    where id = v_task.agent_id;
  elsif not v_released then
    insert into ledger (agent_id, worker_id, task_id, type, amount_cents, created_at)
    values (v_task.agent_id, v_task.claimed_by, p_task_id, 'release', v_task.bounty_cents, p_now);
    if v_task.fee_cents > 0 then
      insert into ledger (agent_id, task_id, type, amount_cents, created_at)
      values (v_task.agent_id, p_task_id, 'fee', v_task.fee_cents, p_now);
    end if;
  end if;

  update tasks set
    status = case
      when p_decision = 'refund' then 'refunded'
      when exists (select 1 from ledger where task_id = p_task_id and type = 'payout') then 'paid'
      else 'verified'
    end,
    dispute_reason = concat_ws(E'\n', dispute_reason, 'resolved ' || p_decision || ': ' || p_note)
  where id = p_task_id
  returning * into v_task;
  return next v_task;
end $$;

revoke execute on function eyes_payouts_due(text, integer) from public;
revoke execute on function eyes_resolve_task(uuid, text, text, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_payouts_due(text, integer) from %I', v_role);
    execute format('revoke execute on function eyes_resolve_task(uuid, text, text, timestamptz) from %I', v_role);
  end loop;
end $$;
