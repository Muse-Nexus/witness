-- Images of removed items that still have to go. Removing items deletes their rows and
-- records each image key here in one batch, then deletes the images from R2 and these
-- records. The rows go first so that a row never points at a missing image (a delivery could
-- otherwise go out with nothing in it). If R2 fails, the items are already gone from
-- Witness and the cron deletes the images from these records. No user data: only object
-- keys "u/<user_id>/<item_id>".
CREATE TABLE media_cleanup_keys (
  key         TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
CREATE INDEX media_cleanup_keys_created ON media_cleanup_keys (created_at);
