create or replace function eyes_reoffer(p_task_id uuid, p_released_by uuid, p_now timestamptz)
returns setof workers language sql as $$
  update offers o set sent_at = p_now
  from tasks t, workers w
  where o.task_id = p_task_id and t.id = o.task_id and w.id = o.worker_id
    and t.status = 'dispatched' and t.deadline_at > p_now
    and w.id <> p_released_by and w.available and w.opted_in
    and not exists (select 1 from tasks c where c.claimed_by = w.id and c.status in ('claimed', 'submitted'))
  returning w.*
$$;

revoke execute on function eyes_reoffer(uuid, uuid, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_reoffer(uuid, uuid, timestamptz) from %I', v_role);
  end loop;
end $$;
