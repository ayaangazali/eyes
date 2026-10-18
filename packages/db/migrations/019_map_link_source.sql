-- Workers can text a map link (Apple or Google Maps) or a "lat, lng" pair to update their spot (T6.13).
-- Those fixes are stored with location_source 'map_link'. Same values as 017 plus 'map_link'.
alter table workers
  drop constraint workers_location_source_check,
  add constraint workers_location_source_check
    check (location_source in ('shortcut', 'here_link', 'capture', 'findmy', 'map_link'));
