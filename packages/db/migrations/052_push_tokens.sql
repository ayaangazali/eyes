-- Expo push tokens (ADR-053). One row per device token, owned by a worker or an agent (the owner console).
-- A token moves to its newest owner. The sender deletes a token when Expo says DeviceNotRegistered.
create table push_tokens (
  token text primary key check (token ~ '^(Exponent|Expo)PushToken\[[^\]]{1,100}\]$'),
  worker_id uuid references workers(id) on delete cascade,
  agent_id uuid references agents(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((worker_id is null) <> (agent_id is null))
);
create index push_tokens_worker on push_tokens (worker_id) where worker_id is not null;
create index push_tokens_agent on push_tokens (agent_id) where agent_id is not null;
alter table push_tokens enable row level security;

create function eyes_add_push_token(p_token text, p_worker_id uuid, p_agent_id uuid)
returns void language sql as $$
  insert into push_tokens (token, worker_id, agent_id) values (p_token, p_worker_id, p_agent_id)
  on conflict (token) do update set worker_id = excluded.worker_id, agent_id = excluded.agent_id, created_at = now()
$$;

create function eyes_push_tokens(p_worker_ids uuid[], p_agent_id uuid)
returns table (token text) language sql stable as $$
  select t.token from push_tokens t
  where t.worker_id = any (p_worker_ids) or t.agent_id = p_agent_id
$$;

create function eyes_remove_push_tokens(p_tokens text[])
returns void language sql as $$
  delete from push_tokens where token = any (p_tokens)
$$;

-- Account deletion keeps the worker row as a tombstone, so its tokens go here.
create function eyes_delete_worker_push_tokens(p_worker_id uuid)
returns void language sql as $$
  delete from push_tokens where worker_id = p_worker_id
$$;

do $$
declare
  v_role name;
begin
  revoke execute on function eyes_add_push_token(text, uuid, uuid) from public;
  revoke execute on function eyes_push_tokens(uuid[], uuid) from public;
  revoke execute on function eyes_remove_push_tokens(text[]) from public;
  revoke execute on function eyes_delete_worker_push_tokens(uuid) from public;
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_add_push_token(text, uuid, uuid) from %I', v_role);
    execute format('revoke execute on function eyes_push_tokens(uuid[], uuid) from %I', v_role);
    execute format('revoke execute on function eyes_remove_push_tokens(text[]) from %I', v_role);
    execute format('revoke execute on function eyes_delete_worker_push_tokens(uuid) from %I', v_role);
  end loop;
end $$;
