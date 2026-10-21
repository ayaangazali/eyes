drop function eyes_list_tasks(uuid, text, integer);

create function eyes_list_tasks(p_agent_id uuid, p_status text, p_limit integer, p_before uuid)
returns setof tasks language sql stable as $$
  select t.* from tasks t
  where t.agent_id = p_agent_id
    and (p_status is null or t.status = p_status)
    and (p_before is null or (t.created_at, t.id) < (
      select cursor.created_at, cursor.id from tasks cursor
      where cursor.id = p_before and cursor.agent_id = p_agent_id
    ))
  order by t.created_at desc, t.id desc
  limit p_limit
$$;

create index tasks_agent_created_id on tasks (agent_id, created_at desc, id desc);

revoke execute on function eyes_list_tasks(uuid, text, integer, uuid) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_list_tasks(uuid, text, integer, uuid) from %I', v_role);
  end loop;
end $$;
