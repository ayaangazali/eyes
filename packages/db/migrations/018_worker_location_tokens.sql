-- Several location codes per worker (one per device: a Mac and an iPhone can both run the shift
-- Shortcut). SHORTCUT adds a code instead of replacing the one code, keeping the 5 newest; STOP
-- deletes them all. Existing codes are copied over so installed Shortcuts keep working.
-- workers.location_token_hash is no longer written (kept, not dropped).
create table worker_location_tokens (
  token_hash text primary key,
  worker_id uuid not null references workers(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index worker_location_tokens_worker on worker_location_tokens (worker_id, created_at desc);
alter table worker_location_tokens enable row level security;

insert into worker_location_tokens (token_hash, worker_id, created_at)
select location_token_hash, id, coalesce(location_at, created_at)
from workers where location_token_hash is not null;
update workers set location_token_hash = null where location_token_hash is not null;

-- Same names and signatures as 017, so a server started before 018 keeps working.
-- last_used_at is written at most once a minute per code.
create or replace function eyes_worker_by_location_token(p_token_hash text)
returns setof workers language plpgsql as $$
begin
  update worker_location_tokens set last_used_at = now()
  where token_hash = p_token_hash and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return query
  select w.* from worker_location_tokens t join workers w on w.id = t.worker_id
  where t.token_hash = p_token_hash and w.opted_in;
end $$;

-- Adds a code (the name is kept from 017, where it replaced the one code).
create or replace function eyes_rotate_location_token(p_worker_id uuid, p_token_hash text)
returns setof workers language plpgsql as $$
begin
  if not exists (select 1 from workers where id = p_worker_id and opted_in) then
    return;
  end if;
  insert into worker_location_tokens (token_hash, worker_id) values (p_token_hash, p_worker_id);
  delete from worker_location_tokens
  where worker_id = p_worker_id and token_hash not in (
    select token_hash from worker_location_tokens where worker_id = p_worker_id
    order by created_at desc, token_hash limit 5
  );
  return query select * from workers where id = p_worker_id;
end $$;

-- STOP deletes the fix and every location code. Same signature as 002.
create or replace function eyes_set_worker_opt_in(p_phone text, p_opted_in boolean)
returns setof workers language plpgsql as $$
begin
  if not p_opted_in then
    delete from worker_location_tokens t using workers w where w.phone = p_phone and t.worker_id = w.id;
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
  where phone = p_phone
  returning *;
end $$;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table worker_location_tokens from %I', v_role);
    execute format('revoke execute on function eyes_worker_by_location_token(text) from %I', v_role);
    execute format('revoke execute on function eyes_rotate_location_token(uuid, text) from %I', v_role);
    execute format('revoke execute on function eyes_set_worker_opt_in(text, boolean) from %I', v_role);
  end loop;
end $$;
revoke execute on function eyes_worker_by_location_token(text) from public;
revoke execute on function eyes_rotate_location_token(uuid, text) from public;
revoke execute on function eyes_set_worker_opt_in(text, boolean) from public;
