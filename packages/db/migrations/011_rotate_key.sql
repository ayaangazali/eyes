create or replace function eyes_rotate_api_key(p_agent_id uuid, p_api_key_hash text)
returns table (agent_id uuid) language sql as $$
  update agents set api_key_hash = p_api_key_hash where id = p_agent_id returning id
$$;

revoke execute on function eyes_rotate_api_key(uuid, text) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_rotate_api_key(uuid, text) from %I', v_role);
  end loop;
end $$;
