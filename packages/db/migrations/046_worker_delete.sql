-- Account deletion from /me (ADR-045). The row stays as a tombstone so tasks, answers, tickets and
-- later payouts keep their keys; every personal field goes. Ledger rows keep their amounts and lose
-- the worker reference. A banned worker's phone is kept so the ban still blocks rejoining.
alter table workers add column deleted_at timestamptz;

create function eyes_delete_worker(p_worker_id uuid, p_now timestamptz)
returns setof workers language plpgsql as $$
declare
  v_task uuid;
  v_phone text;
begin
  -- Same lock as eyes_claim, so no claim lands between the check and the delete.
  select phone into v_phone from workers where id = p_worker_id and deleted_at is null for update;
  if not found then return; end if;
  select id into v_task from tasks
  where claimed_by = p_worker_id and status in ('claimed', 'submitted', 'needs_review', 'disputed')
  limit 1;
  if found then
    raise exception 'eyes:invalid_input %', json_build_object('task_id', v_task);
  end if;
  -- STOP as live runs it (no eyes_stop_worker here): opted out, no texts, location fix, location codes and devices deleted.
  perform eyes_set_worker_opt_in(v_phone, false);
  delete from worker_connect_codes where worker_id = p_worker_id;
  delete from short_links where worker_id = p_worker_id;
  update ledger set worker_id = null where worker_id = p_worker_id;
  return query update workers set
    name = '',
    phone = case when banned then phone else 'deleted:' || id end,
    email = null,
    email_verified_at = null,
    location_received_at = null,
    location_day_start = null,
    location_day_count = 0,
    deleted_at = p_now
  where id = p_worker_id
  returning *;
end $$;

revoke execute on function eyes_delete_worker(uuid, timestamptz) from public;
