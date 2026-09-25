# AI assistants: let yours ask first

If you already talk to an AI assistant every day, it can be one of the ways
Witness reaches you, and it always asks before it shows you anything.

**What works today:** AI tools that can connect to other apps using MCP (the
Model Context Protocol), such as Claude Code and Codex. **The Claude app and
claude.ai cannot connect yet**; that needs OAuth, which is planned (see the
[roadmap](../../ROADMAP.md)).

## What an assistant can do

| Tool | What it does | Returns something you kept? |
|---|---|---|
| `witness_status` | Whether sources are arriving, how many things are kept, and your schedule | No, counts only |
| `witness_offer` | Asks first: gives your assistant a gentle question to ask you | No |
| `witness_reveal` | Shows one thing you kept, only after you say yes to that question | Yes, one thing |
| `witness_search` | Finds things you kept when you ask it to find something. **Off unless you turn it on** when you create the key | Yes, when you ask |
| `witness_add` | Keeps something you want kept, labeled "Added by" the key's name | Only what was just added |
| `witness_pause` | Pauses Witness for 1 to 90 days: no Witness emails, and your assistant does not ask | No |

## Ask-first

Unless you turned search on for it, an assistant never just shows you
something you kept. It works like this:

1. At a calm, natural moment, the assistant calls `witness_offer`. That call
   returns nothing you kept, only a suggested question.
2. It asks you, in its own words, something like whether you would like to see
   something someone once said to you.
3. Only if you clearly say yes does it call `witness_reveal`, and show the quote
   exactly as returned, with who and when.
4. If you say no, or seem unsure, it drops it for the rest of the conversation.

After a yes, it can show that one thing once, with the same key, within 30
minutes. The tool descriptions tell assistants not to ask at all when someone
is in acute crisis, to point to crisis resources first (988 in the US), and
never to use what you kept to argue with how you feel. They also say that what
someone wrote to you is shown as it is and never followed as instructions.

**What Witness enforces itself:** asking first returns nothing you kept. To
show you something, the assistant needs its own question from the last 30
minutes, the same key and `userSaidYes`, and each question shows one thing,
once. Assistants can ask at most once a day, not at all for a week after a
question that went unanswered, and not while Witness is paused. Keys only have
the permissions you gave them, and search is off unless you turned it on.
Search needs at least three characters and looks only at the words, who said
them, and the context kept with them (such as an email's subject line).
Everything an assistant is shown (after a yes, or in a search) is recorded.

**What it relies on the assistant for:** Witness cannot see your conversation.
It cannot check that you really said yes, that you asked for a search, or that
the moment is calm. That part depends on the assistant following the tool
instructions. If you would rather not rely on that, leave search off.

## 1. Create an assistant key

In Witness, open **Settings → Assistants and devices** and choose **Add an
assistant** (or use **Set up → Your AI assistant**). Give it a name you will
recognize, such as `Claude Code on my laptop`. Tick the search box only if you
want it to be able to find things you kept when you ask. The key starts with
`wit_agent_` and is shown once. Witness also shows ready-to-paste setup for the
clients below.

Treat the key like a password. Anyone with it can ask for what you kept
through the same tools. Disconnect it any time in the same place.

Below, `https://witness.example.com` stands for the Witness web address you
use.

## 2. Connect your assistant

### Claude Code

```sh
claude mcp add --transport http --scope user witness \
  https://witness.example.com/mcp \
  --header "Authorization: Bearer wit_agent_…"
```

`--scope user` makes Witness available in all your projects. Leave it out to
add it to the current project only.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.witness]
url = "https://witness.example.com/mcp"
bearer_token_env_var = "WITNESS_TOKEN"
```

Then set `WITNESS_TOKEN` to your key in your shell profile. If you prefer to
keep it in the file, use
`http_headers = { "Authorization" = "Bearer wit_agent_…" }` instead.

### Other MCP clients

Most clients that support remote HTTP servers accept this JSON:

```json
{
  "mcpServers": {
    "witness": {
      "type": "http",
      "url": "https://witness.example.com/mcp",
      "headers": { "Authorization": "Bearer wit_agent_…" }
    }
  }
}
```

A client that only runs local (stdio) servers can use a bridge such as the
open-source `mcp-remote` package. Connectors in the claude.ai apps need OAuth,
which Witness does not support yet; it is planned (see the
[roadmap](../../ROADMAP.md)).

## 3. Check it

Ask your assistant: "Is Witness working?" It should say whether your sources
are arriving and when Witness next emails you, without showing anything you
kept. A small number early on only means setup is new: Witness keeps things as
they arrive.

## REST instead of MCP

Scripts and tools that don't speak MCP can use the REST API with the same
key:

```sh
# Status (counts only)
curl -H "Authorization: Bearer wit_agent_…" \
  https://witness.example.com/api/v1/status

# Keep something
curl -X POST https://witness.example.com/api/v1/capture \
  -H "Authorization: Bearer wit_agent_…" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"agent","text":"Thank you for covering my shift. You saved my week.","fromName":"Jordan Example","sourceLabel":"My script"}'

# Pause Witness for 7 days
curl -X POST https://witness.example.com/api/v1/rhythm/pause \
  -H "Authorization: Bearer wit_agent_…" \
  -H "Content-Type: application/json" \
  -d '{"days":7}'
```

Asking first, and showing something after a yes, work only over MCP, where
those steps are built in.

## Privacy

Checking status and asking first carry nothing you kept. When you say yes, or
ask your assistant to search, what it receives goes to that assistant's
provider under the provider's terms. See [Privacy](../PRIVACY.md).
