-- Ops can suspend an agent, and a revoke kills every owner link made so far (ADR-052).
-- Owner links carry the version they were made with; a link whose version differs from this one is dead.
alter table agents
  add column suspended boolean not null default false,
  add column owner_link_version integer not null default 0;

create function eyes_set_agent_suspended(p_agent_id uuid, p_suspended boolean)
returns setof agents language sql as $$
  update agents set suspended = p_suspended where id = p_agent_id returning *
$$;

create function eyes_revoke_owner_links(p_agent_id uuid)
returns setof agents language sql as $$
  update agents set owner_link_version = owner_link_version + 1 where id = p_agent_id returning *
$$;

revoke execute on function eyes_set_agent_suspended(uuid, boolean) from public;
revoke execute on function eyes_revoke_owner_links(uuid) from public;
