create function eyes_dashboard_feed(p_limit integer)
returns table (tasks jsonb, ledger jsonb, workers jsonb, totals jsonb) language sql stable as $$
  select
    coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at desc)
      from (
        select t.id, t.question, t.place_label, t.lat, t.lng, t.status, t.bounty_cents, t.fee_cents,
          t.created_at, t.claimed_at, t.deadline_at,
          (select count(*) from offers o where o.task_id = t.id)::integer as workers_notified,
          s.created_at as submitted_at, s.photo_url, s.gps_ok, s.fresh_ok, s.vision_ok, s.confidence,
          (select jsonb_object_agg(l.type, l.created_at) from ledger l where l.task_id = t.id) as money_at
        from tasks t
        left join lateral (
          select * from submissions sub where sub.task_id = t.id order by sub.created_at desc limit 1
        ) s on true
        order by t.created_at desc
        limit p_limit
      ) f
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select type, amount_cents, task_id, created_at from ledger order by created_at desc limit p_limit
      ) l
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(w))
      from (
        select id, lat, lng, available, opted_in from workers order by created_at desc limit p_limit
      ) w
    ), '[]'::jsonb),
    (
      select jsonb_build_object(
        'escrowed_cents', coalesce(sum(case type when 'escrow' then amount_cents else -amount_cents end)
          filter (where type in ('escrow', 'release', 'fee', 'refund')), 0),
        'released_today_cents', coalesce(sum(amount_cents)
          filter (where type = 'release' and created_at >= date_trunc('day', now(), 'UTC')), 0),
        'paid_out_today_cents', coalesce(sum(amount_cents)
          filter (where type = 'payout' and created_at >= date_trunc('day', now(), 'UTC')), 0)
      )
      from ledger
    )
$$;

revoke execute on function eyes_dashboard_feed(integer) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_dashboard_feed(integer) from %I', v_role);
  end loop;
end $$;
