# Outlook: forward kind email to Witness

This works for Outlook.com, Hotmail and Live addresses, Outlook on the web,
and the new Outlook for Windows, which share the same settings.
You do it once.

You need:

- Your Witness address, shown in **Setup → Email** (it looks like
  `witness+k3v9q2m7xa@in.example.com`).
- Outlook on the web (outlook.com) or the new Outlook for Windows.

If the Outlook address is not the one you sign in to Witness with, add it first
in Witness under **Settings → Email addresses**. Witness only accepts mail from
addresses you have added.

## Create one rule

1. Select **Settings** (the gear), then **Mail → Rules**.
2. Select **Add new rule** (or **Add rule**) and name it `Witness`.
3. Under **Add a condition**, choose **Subject or body includes**, then add the
   phrases Witness shows you in **Setup → Email**, one at a time. For example:
   `thank you`, `proud of you`, `congratulations`.
4. Under **Add an action**, choose **Forward to** and enter your Witness
   address.
5. Optional: under **Add an exception**, choose **Sender address includes**
   and add `noreply` and `no-reply`, so automated mail is not forwarded.
6. Select **Save**.

From now on, matching messages go to Witness. The detector keeps clear
evidence, puts uncertain finds in "maybe", and drops the rest without storing
them. Rules apply to new mail; to add an older message, forward it by hand.

## Good to know

- **Use Forward to.** With **Forward to**, the message arrives from your own
  address, which Witness recognizes, and Witness reads the original sender and
  date from the forwarded header. We have not tested **Redirect to** with
  Witness.
- **Confirmation.** Outlook usually does not ask the receiving address to
  confirm. If it ever does, Witness shows the confirmation in **Setup → Email**,
  as it does for Gmail.
- **Work or school accounts (Microsoft 365).** Many organizations block
  automatic forwarding to outside addresses. The rule may save without error,
  but messages never arrive, and you may get a bounce saying your organization
  does not allow external forwarding. Ask your administrator, or use a personal
  account.
- **Labels may differ slightly.** Microsoft updates Outlook often. If you do not
  see **Subject or body includes**, look for **Subject includes** and **Body
  includes** and add a rule for each.
- **Stopping.** Delete the `Witness` rule under **Settings → Mail → Rules**.

Microsoft's help: [Use rules to automatically forward
messages](https://support.microsoft.com/en-us/outlook/mail/use-rules-to-automatically-forward-messages).
Checked in September 2026.

Screenshots for this guide are welcome; see the
[good first issues](../dev/good-first-issues.md).
