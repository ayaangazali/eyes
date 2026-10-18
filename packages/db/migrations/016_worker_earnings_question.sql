-- Worker earnings page: each task row also carries its question and task type, so the page can say
-- what the worker checked instead of only where. Same signature as 012, body replaced in place.
create or replace function eyes_worker_earnings(p_worker_id uuid)
returns table (paid_cents bigint, pending_cents bigint, payouts_set_up boolean, tasks jsonb)
language sql stable as $$
  select
    coalesce((
      select sum(amount_cents) from ledger where worker_id = w.id and type = 'payout'
    ), 0)::bigint,
    coalesce((
      select sum(r.amount_cents) from ledger r
      where r.worker_id = w.id and r.type = 'release'
        and not exists (select 1 from ledger p where p.task_id = r.task_id and p.type = 'payout')
    ), 0)::bigint,
    w.stripe_account_id is not null,
    coalesce((
      select jsonb_agg(to_jsonb(x) order by x.claimed_at desc)
      from (
        select t.id as task_id, t.question, t.task_type, t.place_label, t.status, t.bounty_cents, t.claimed_at,
          r.id is not null as released, p.created_at as paid_at
        from tasks t
        left join ledger r on r.task_id = t.id and r.type = 'release'
        left join ledger p on p.task_id = t.id and p.type = 'payout'
        where t.claimed_by = w.id
        order by t.claimed_at desc
        limit 50
      ) x
    ), '[]'::jsonb)
  from workers w
  where w.id = p_worker_id
$$;

revoke execute on function eyes_worker_earnings(uuid) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_worker_earnings(uuid) from %I', v_role);
  end loop;
end $$;
