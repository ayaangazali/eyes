create or replace function eyes_claim(p_worker_id uuid, p_now timestamptz)
returns table (outcome text, task tasks) language plpgsql as $$
declare
  v_task tasks;
  v_won tasks;
begin
  if not exists (select 1 from workers where id = p_worker_id and opted_in and available) then
    return;
  end if;

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
      return;
    end if;
    return query
    select case when t.claimed_by = p_worker_id then 'already_yours' else 'lost' end, t
    from tasks t where t.id = v_task.id and t.claimed_by is not null;
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
