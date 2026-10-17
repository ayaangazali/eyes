create or replace function eyes_credit_paid_topup(p_agent_id uuid, p_amount_cents bigint, p_stripe_ref text, p_now timestamptz)
returns table (agent_id uuid, first_paid boolean) language plpgsql as $$
declare
  v_first boolean;
begin
  perform 1 from agents where id = p_agent_id for update;
  v_first := not exists (
    select 1 from ledger l
    where l.agent_id = p_agent_id and l.type = 'topup' and l.stripe_ref <> ('signup:' || p_agent_id)
  );
  perform * from eyes_credit_topup(p_agent_id, p_amount_cents, p_stripe_ref, p_now);
  return query select p_agent_id, v_first and exists (
    select 1 from ledger l where l.type = 'topup' and l.stripe_ref = p_stripe_ref and l.agent_id = p_agent_id
  );
end $$;

revoke execute on function eyes_credit_paid_topup(uuid, bigint, text, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_credit_paid_topup(uuid, bigint, text, timestamptz) from %I', v_role);
  end loop;
end $$;
