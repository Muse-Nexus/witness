-- "Allow again" in Settings needs something to call a blocked sender by.
-- label_ct is the sender's display name as it appeared on the item that was
-- blocked, encrypted with the user's key (SPEC §7). The sender itself stays a
-- keyed hash (sender_key); the handle is never stored.
ALTER TABLE blocked_senders ADD COLUMN label_ct TEXT;
