# iCloud Mail: forward kind email to Witness

You set this up once at iCloud.com. It works for `@icloud.com`, `@me.com` and
`@mac.com` addresses.

You need:

- Your Witness address, shown in **Setup → Email** (it looks like
  `witness+k3v9q2m7xa@in.example.com`).
- A web browser, signed in at [icloud.com/mail](https://www.icloud.com/mail).

If the iCloud address is not the one you sign in to Witness with, add it first
in Witness under **Settings → Email addresses**. Witness only accepts mail from
addresses you have added.

## What iCloud rules can and cannot do

iCloud Mail rules match on who a message is from or to, and on words in the
**subject**. They cannot search the message body. So there are two good ways
to set this up. Choose one.

### Option 1: forward from the people who matter

Best if kind messages mostly come from a handful of people.

1. At icloud.com/mail, select the **Settings** button at the top of the
   mailbox list, then **Settings**.
2. Select **Rules**, then **Add** (or **Add a Rule**).
3. Name the rule `Witness`.
4. Under the message condition, choose **is from** and enter one person's
   address.
5. Under the action, choose the forward action (**Forward to**) and enter your
   Witness address.
6. Select **Add**. Repeat for each person, or add a rule with **subject
   contains** and a phrase such as `thank you`.

### Option 2: forward everything and let Witness choose

iCloud Mail can forward all incoming mail to another address. Witness then
keeps only clear evidence, puts uncertain finds in "maybe", and stores nothing
from everything else except a content-free outcome.

This is the least work, but it means every message you receive passes through
Witness on the way. Read [Privacy](../PRIVACY.md) before choosing it.

In iCloud Mail **Settings**, look for the forwarding option (it is labeled
along the lines of **Forward my email to**), enter your Witness address, and
choose whether to keep a copy in iCloud. Keep a copy.

## Good to know

- **Rules take a little while.** Apple says new or changed rules can take up
  to 15 minutes to apply, and you can have up to 500 rules.
- **New mail only.** Rules act on messages that arrive after you create them.
  To add an older message, forward it by hand to your Witness address.
- **Confirmation.** We have not seen iCloud ask the receiving address to
  confirm. If it ever does, Witness shows the confirmation in
  **Setup → Email**.
- **Stopping.** Delete the rules under **Settings → Rules**, or turn off
  forwarding.
- **Test it.** From another account, send a kind test message that matches
  your rule, then check that **Setup → Email** shows something arrived. Not
  verified: how iCloud identifies the forwarding sender to the receiving
  server. If nothing arrives, please open an issue so we can look.

Apple's help: [Set up rules to filter email in Mail on
iCloud.com](https://support.apple.com/guide/icloud/set-up-filtering-rules-mm6b1a3f8a/icloud).
Checked in September 2026. Not verified: the exact label of iCloud's
forward-everything setting, which Apple's help page does not name.
