-- Ad hoc install (T6.31): a worker's iPhone sends its device ID (UDID) through an iOS Profile Service
-- profile so the operator can register it with Apple and build an .ipa that installs from a link.
-- apple_registered_at: registered in the Apple developer account. released_at: in an uploaded build
-- and the worker was texted. STOP deletes the rows.
create table worker_devices (
  udid text primary key check (udid ~ '^[0-9A-Fa-f-]{25,40}$'),
  worker_id uuid not null references workers(id),
  product text,
  os_version text,
  created_at timestamptz not null default now(),
  apple_registered_at timestamptz,
  released_at timestamptz
);
create index worker_devices_worker on worker_devices (worker_id);
alter table worker_devices enable row level security;

-- Adds (or moves to this worker) a device. Only for an opted-in worker; returns nothing otherwise.
create function eyes_add_worker_device(p_worker_id uuid, p_udid text, p_product text, p_os_version text)
returns setof worker_devices language plpgsql as $$
begin
  if not exists (select 1 from workers where id = p_worker_id and opted_in) then
    return;
  end if;
  return query
  insert into worker_devices (udid, worker_id, product, os_version) values (p_udid, p_worker_id, p_product, p_os_version)
  on conflict (udid) do update set
    product = excluded.product,
    os_version = excluded.os_version,
    released_at = case when worker_devices.worker_id = excluded.worker_id then worker_devices.released_at end,
    worker_id = excluded.worker_id
  returning *;
end $$;

create function eyes_worker_devices(p_worker_id uuid)
returns setof worker_devices language sql stable as $$
  select * from worker_devices where worker_id = p_worker_id order by created_at
$$;

-- Same as 021, plus STOP deletes the worker's devices.
create or replace function eyes_set_worker_opt_in(p_phone text, p_opted_in boolean)
returns setof workers language plpgsql as $$
begin
  if not p_opted_in then
    delete from worker_location_tokens t using workers w where w.phone = p_phone and t.worker_id = w.id;
    delete from worker_devices d using workers w where w.phone = p_phone and d.worker_id = w.id;
  end if;
  return query
  update workers set
    opted_in = p_opted_in,
    available = p_opted_in,
    lat = case when p_opted_in then lat end,
    lng = case when p_opted_in then lng end,
    location_at = case when p_opted_in then location_at end,
    location_accuracy_m = case when p_opted_in then location_accuracy_m end,
    location_source = case when p_opted_in then location_source end,
    location_token_hash = null
  where phone = p_phone and not (p_opted_in and banned)
  returning *;
end $$;

revoke execute on function eyes_add_worker_device(uuid, text, text, text) from public;
revoke execute on function eyes_worker_devices(uuid) from public;
revoke execute on function eyes_set_worker_opt_in(text, boolean) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table worker_devices from %I', v_role);
    execute format('revoke execute on function eyes_add_worker_device(uuid, text, text, text) from %I', v_role);
    execute format('revoke execute on function eyes_worker_devices(uuid) from %I', v_role);
    execute format('revoke execute on function eyes_set_worker_opt_in(text, boolean) from %I', v_role);
  end loop;
end $$;
