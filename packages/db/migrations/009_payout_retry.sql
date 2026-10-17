create or replace function eyes_payout_begin(p_task_id uuid)
returns setof ledger language plpgsql as $$
declare
  v_now_us bigint;
begin
  perform 1 from tasks where id = p_task_id and status = 'verified' for update;
  if not found then
    return;
  end if;
  v_now_us := floor(extract(epoch from clock_timestamp()) * 1000000);
  return query
  update ledger set stripe_ref = format('payout:%s:%s', p_task_id, v_now_us)
  where task_id = p_task_id and type = 'release'
    and (stripe_ref is null or split_part(stripe_ref, ':', 3)::bigint <= v_now_us - 15 * 60 * 1000000::bigint)
  returning *;
end $$;

create or replace function eyes_payout_end(p_task_id uuid, p_key text)
returns setof ledger language sql as $$
  update ledger set stripe_ref = null
  where task_id = p_task_id and type = 'release' and stripe_ref = p_key
  returning *
$$;

drop function if exists eyes_payouts_due(text, integer);

create or replace function eyes_payouts_due(p_account_id text, p_limit integer, p_after uuid)
returns table (task tasks, worker workers) language sql stable as $$
  select t, w
  from tasks t join workers w on w.id = t.claimed_by
  where t.status = 'verified' and w.stripe_account_id is not null
    and (p_account_id is null or w.stripe_account_id = p_account_id)
    and (p_after is null or (t.created_at, t.id) > (select a.created_at, a.id from tasks a where a.id = p_after))
  order by t.created_at, t.id
  limit p_limit
$$;

revoke execute on function eyes_payout_begin(uuid) from public;
revoke execute on function eyes_payout_end(uuid, text) from public;
revoke execute on function eyes_payouts_due(text, integer, uuid) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_payout_begin(uuid) from %I', v_role);
    execute format('revoke execute on function eyes_payout_end(uuid, text) from %I', v_role);
    execute format('revoke execute on function eyes_payouts_due(text, integer, uuid) from %I', v_role);
  end loop;
end $$;
