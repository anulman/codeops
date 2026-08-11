BEGIN;

DROP TABLE codeops.work_item_lifecycle_publications;
DROP TRIGGER work_item_lifecycle_events_immutable
  ON codeops.work_item_lifecycle_events;
DROP FUNCTION codeops.reject_work_item_lifecycle_event_mutation();
DROP TABLE codeops.work_item_lifecycle_events;
DROP TABLE codeops.work_item_lifecycle;

COMMIT;
