-- The Eyes iOS app posts background fixes to /w/location with source 'app' (T6.15).
-- Same values as 019 plus 'app'.
alter table workers
  drop constraint workers_location_source_check,
  add constraint workers_location_source_check
    check (location_source in ('shortcut', 'here_link', 'capture', 'findmy', 'map_link', 'app'));
