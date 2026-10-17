create function eyes_owner_console(p_agent_id uuid, p_now timestamptz)
returns table (
  agent_name text,
  balance_cents bigint,
  escrowed_cents bigint,
  spent_today_cents bigint,
  daily_cap_cents bigint,
  max_bounty_cents bigint,
  allowed_task_types text[],
  tasks jsonb,
  ledger jsonb
) language sql stable as $$
  select a.name, s.balance_cents, s.escrowed_cents, s.spent_today_cents, s.daily_cap_cents, s.max_bounty_cents,
    s.allowed_task_types,
    coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at desc)
      from (
        select id as task_id, question, place_label, status, bounty_cents, created_at
        from tasks where agent_id = p_agent_id order by created_at desc limit 20
      ) t
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select type, amount_cents, task_id, created_at
        from ledger where agent_id = p_agent_id order by created_at desc limit 50
      ) l
    ), '[]'::jsonb)
  from agents a cross join lateral eyes_agent_summary(a.id, p_now) s
  where a.id = p_agent_id
$$;

create function eyes_update_spend_policy(
  p_agent_id uuid,
  p_max_bounty_cents bigint,
  p_daily_cap_cents bigint,
  p_allowed_task_types text[],
  p_now timestamptz
) returns table (
  balance_cents bigint,
  escrowed_cents bigint,
  spent_today_cents bigint,
  daily_cap_cents bigint,
  max_bounty_cents bigint,
  allowed_task_types text[]
) language plpgsql as $$
begin
  update agents a set max_bounty_cents = p_max_bounty_cents, daily_cap_cents = p_daily_cap_cents,
    allowed_task_types = p_allowed_task_types
  where a.id = p_agent_id;
  return query select * from eyes_agent_summary(p_agent_id, p_now);
end $$;

revoke execute on function eyes_owner_console(uuid, timestamptz) from public;
revoke execute on function eyes_update_spend_policy(uuid, bigint, bigint, text[], timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_owner_console(uuid, timestamptz) from %I', v_role);
    execute format(
      'revoke execute on function eyes_update_spend_policy(uuid, bigint, bigint, text[], timestamptz) from %I',
      v_role
    );
  end loop;
end $$;
