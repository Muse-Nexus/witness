# Gmail: forward kind email to Witness

You do this once, on a computer. After that, Gmail quietly forwards messages
that look kind, and Witness keeps the real ones.

You need:

- Your Witness address, shown in **Setup → Email** (it looks like
  `witness+k3v9q2m7xa@in.example.com`).
- Gmail in a web browser on a computer. The Gmail phone app cannot set up
  forwarding or filters.

If you forward from a Gmail address that is not the one you sign in to Witness
with, add it first in Witness under **Settings → Email addresses**. Witness
only accepts mail from addresses you have added.

## 1. Add your Witness address to Gmail

1. In Gmail, select **Settings** (the gear), then **See all settings**.
2. Open the **Forwarding and POP/IMAP** tab.
3. Select **Add a forwarding address**, paste your Witness address, then
   select **Next**, **Proceed**, and **OK**.

Gmail now sends a confirmation email to your Witness address.

## 2. Confirm it from Witness

Witness recognizes Gmail's confirmation email and shows it in
**Setup → Email**, usually within a minute:

1. Select **Confirm** in Witness. A Google page opens.
2. If Google asks you to confirm, choose **Confirm**.

If you prefer, Witness also shows the confirmation code. Paste it into the
confirmation box on Gmail's **Forwarding and POP/IMAP** tab and select
**Verify**.

After confirming, leave Gmail's main forwarding setting on **Disable
forwarding**. You do not want to forward everything; the filter in the next
step forwards only likely-kind messages.

## 3. Create one filter

Witness shows you a search string in **Setup → Email**. Copy it exactly. It
looks something like this (yours may differ):

```text
("thank you" OR "proud of you" OR congrats) -category:promotions -category:social -from:noreply
```

1. Paste the string into Gmail's search box at the top and press Enter.
2. Select **Show search options** (the sliders icon at the right end of the
   search box). The string appears in **Has the words**.
3. Select **Create filter**.
4. Tick **Forward it to** and choose your Witness address.
5. Select **Create filter**.

That's it. From now on, matching messages go to Witness. The detector keeps
clear evidence, puts uncertain finds in "maybe", and drops the rest without
storing them.

## Good to know

- **New mail only.** Gmail filters forward new messages, not ones already in
  your inbox. To add an older message, forward it by hand to your Witness
  address.
- **Forward anything, any time.** You can also forward any kind message to
  your Witness address yourself.
- **A reminder banner.** Gmail may show a notice for a while that forwarding
  is on. That is expected.
- **Work or school accounts.** Your administrator may block forwarding to
  outside addresses. If the forward option is missing or messages never
  arrive, that is likely the reason.
- **Checking it works.** **Setup → Email** shows when Witness last received
  something. It shows counts and dates, never message text.
- **Stopping.** In Gmail, delete the filter under **Settings → See all
  settings → Filters and Blocked Addresses**, and remove the forwarding
  address under **Forwarding and POP/IMAP**.

Gmail's own help: [Automatically forward Gmail messages to another
account](https://support.google.com/mail/answer/10957) and [Create rules to
filter your emails](https://support.google.com/mail/answer/6579). Gmail's
wording was checked in September 2026 and may change.
