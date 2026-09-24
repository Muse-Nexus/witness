-- One delivery email at a time per person. Every sender (the cron and "Send one now")
-- claims the person's rhythm row before it picks an item and hands the email to the mail
-- provider, and lets go after recording it, so two senders can never pick and send the
-- same thing at once. delivery_claim holds the claimant's id; delivery_claim_until lets a
-- claim left by a sender that died run out by itself.
ALTER TABLE rhythms ADD COLUMN delivery_claim TEXT;
ALTER TABLE rhythms ADD COLUMN delivery_claim_until INTEGER;
