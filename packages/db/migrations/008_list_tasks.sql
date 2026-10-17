create or replace function eyes_list_tasks(p_agent_id uuid, p_status text, p_limit integer)
returns setof tasks language sql stable as $$
  select * from tasks
  where agent_id = p_agent_id and (p_status is null or status = p_status)
  order by created_at desc
  limit p_limit
$$;

revoke execute on function eyes_list_tasks(uuid, text, integer) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_list_tasks(uuid, text, integer) from %I', v_role);
  end loop;
end $$;
