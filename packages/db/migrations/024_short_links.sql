-- Short links in texts: /s/<id> on the API host redirects to `target` (a full link, which may carry a
-- #c=... fragment) until expires_at. id: 8 random base62 characters. Rows go with their worker.
create table short_links (
  id text primary key check (id ~ '^[0-9A-Za-z]{8}$'),
  target text not null,
  worker_id uuid references workers(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index short_links_worker on short_links (worker_id);
alter table short_links enable row level security;

create function eyes_add_short_link(p_id text, p_target text, p_worker_id uuid, p_expires_at timestamptz)
returns setof short_links language sql as $$
  insert into short_links (id, target, worker_id, expires_at) values (p_id, p_target, p_worker_id, p_expires_at)
  returning *
$$;

-- Only a link that has not expired at p_now.
create function eyes_short_link(p_id text, p_now timestamptz)
returns setof short_links language sql stable as $$
  select * from short_links where id = p_id and expires_at > p_now
$$;

revoke execute on function eyes_add_short_link(text, text, uuid, timestamptz) from public;
revoke execute on function eyes_short_link(text, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table short_links from %I', v_role);
    execute format('revoke execute on function eyes_add_short_link(text, text, uuid, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_short_link(text, timestamptz) from %I', v_role);
  end loop;
end $$;
