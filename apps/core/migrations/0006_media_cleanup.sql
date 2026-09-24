-- Images of a deleted account that still have to go. Deleting an account removes its R2
-- objects, then its D1 rows, then sweeps R2 once more for anything written in between. If
-- that last sweep fails, the rows are already gone, so this record (written in the same
-- batch as the row deletes) is what lets the cron finish the job. The cron keeps sweeping
-- a prefix for an hour, then drops the record. No user data: only the key prefix
-- "u/<user_id>/".
CREATE TABLE media_cleanup (
  prefix      TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
