create or replace function eyes_release_claim(p_worker_id uuid, p_now timestamptz)
returns setof tasks language plpgsql as $$
begin
  return query
  update tasks t set status = 'dispatched', claimed_by = null, claimed_at = null
  where t.claimed_by = p_worker_id and t.status = 'claimed' and t.deadline_at > p_now
    and not exists (select 1 from submissions s where s.task_id = t.id)
  returning t.*;
end $$;

revoke execute on function eyes_release_claim(uuid, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_release_claim(uuid, timestamptz) from %I', v_role);
  end loop;
end $$;
