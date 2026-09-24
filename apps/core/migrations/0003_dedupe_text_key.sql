-- Keyed dedupe (SPEC §5, as built): dedupe_key is now an HMAC with a key derived from the
-- master key and the user id, not a plain SHA-256 of the text, so a database copy without
-- the key cannot be used to confirm guessed messages. Older plain keys stay until those
-- rows go; captures check both forms.
--
-- text_key: the same keyed hash over the message text alone, set for every item with text.
-- It lets the same words arriving by two paths (the Mac helper with a message id, the
-- iPhone Shortcut without one) be recognised as one message.
ALTER TABLE items ADD COLUMN text_key TEXT;
CREATE INDEX items_user_text_key ON items (user_id, text_key);
