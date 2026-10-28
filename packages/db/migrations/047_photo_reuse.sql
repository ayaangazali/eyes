-- Photo reuse check: exact (SHA-256) and perceptual (64-bit dHash) fingerprints per answer photo.
alter table submissions add column photo_sha256 text, add column photo_phash bigint;
create index submissions_photo_sha256 on submissions (photo_sha256) where photo_sha256 is not null;

create function eyes_photo_reuse(p_sha256 text, p_phash bigint, p_max_distance integer)
returns table (reused boolean) language sql stable as $$
  select exists (select 1 from submissions
    where photo_sha256 = p_sha256
       or (p_phash is not null and photo_phash is not null
           and bit_count((photo_phash # p_phash)::bit(64)) <= p_max_distance))
$$;

create function eyes_store_photo_hash(p_task_id uuid, p_worker_id uuid, p_sha256 text, p_phash bigint)
returns setof uuid language sql as $$
  update submissions set photo_sha256 = p_sha256, photo_phash = p_phash
  where task_id = p_task_id and worker_id = p_worker_id and photo_url is not null returning id
$$;

revoke execute on function eyes_photo_reuse(text, bigint, integer) from public;
revoke execute on function eyes_store_photo_hash(uuid, uuid, text, bigint) from public;
