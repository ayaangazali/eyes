-- Payout fraud guards (ADR-054). The agent owner's email is stored so an answer from a worker with
-- the same email goes to manual review instead of auto-paying.
alter table agents add column owner_email text check (owner_email = lower(owner_email));

create function eyes_set_agent_owner_email(p_agent_id uuid, p_email text)
returns setof uuid language sql as $$
  update agents set owner_email = lower(p_email) where id = p_agent_id returning id
$$;

create function eyes_owner_is_worker(p_task_id uuid, p_worker_id uuid)
returns setof jsonb language sql stable as $$
  select jsonb_build_object('matched', exists (
    select 1 from tasks t
    join agents a on a.id = t.agent_id
    join workers w on w.id = p_worker_id
    where t.id = p_task_id and a.owner_email is not null and a.owner_email = w.email))
$$;

-- Payouts stay held while the worker is banned, on dispute hold, or has an open dispute ticket.
create function eyes_worker_payouts_held(p_worker_id uuid)
returns setof jsonb language sql stable as $$
  select jsonb_build_object('held', w.banned or w.dispute_hold_at is not null
    or exists (select 1 from tickets k where k.worker_id = w.id and k.kind = 'dispute' and k.status = 'open'))
  from workers w where w.id = p_worker_id
$$;

revoke execute on function eyes_set_agent_owner_email(uuid, text) from public;
revoke execute on function eyes_owner_is_worker(uuid, uuid) from public;
revoke execute on function eyes_worker_payouts_held(uuid) from public;
