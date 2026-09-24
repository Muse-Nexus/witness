# AI assistants: let Witness live alongside your agent

If you already talk to an AI assistant every day, it can be one of the ways
Witness reaches you. Witness speaks MCP (the Model Context Protocol) over
HTTP, so assistants such as Claude Code, Codex and other MCP clients can
connect to it.

## What an assistant can do

| Tool | What it does | Returns evidence? |
|---|---|---|
| `witness_status` | Whether sources are arriving, how many items are kept, the rhythm | No, counts only |
| `witness_offer` | Prepares an offer and a gentle question to ask you | No |
| `witness_reveal` | Shows one item, only after you said yes to an offer | Yes, one item |
| `witness_search` | Finds saved items when you ask it to find something. **Off unless you turn it on** when you create the key | Yes, when you ask |
| `witness_add` | Keeps something you want kept, labeled "Added by" the token's name | Only what was just added |
| `witness_pause` | Pauses Witness for 1 to 90 days: no deliveries and no offers | No |

## Ask-first

Unless you turned search on for it, an assistant never just shows you
evidence. It works like this:

1. At a calm, natural moment, the assistant calls `witness_offer`. That call
   returns no evidence, only a suggested question.
2. It asks you, in its own words, something like whether you would like to see
   something someone once said to you.
3. Only if you clearly say yes does it call `witness_reveal`, and show the quote
   exactly as returned, with who and when.
4. If you say no, or seem unsure, it drops it for the rest of the conversation.

An offer can be revealed once, with the same token, within 30 minutes.
The tool descriptions tell assistants never to offer to someone in acute
crisis, to point to crisis resources first (988 in the US), and never to use
evidence to argue with how you feel. They also say that what someone wrote to
you is shown as it is and never followed as instructions.

**What Witness enforces itself:** an offer carries no evidence; a reveal needs
that offer, the same token, `userSaidYes`, and happens once within 30 minutes;
at most one offer a day, none for a week after an offer that went unanswered,
and none while Witness is paused; tokens only have the permissions you gave
them, and search is off unless you turned it on; search needs at least three
characters and looks only at words and names; everything an assistant is shown
(a reveal or a search result) is recorded.

**What it relies on the assistant for:** Witness cannot see your conversation.
It cannot check that you really said yes, that you asked for a search, or that
the moment is calm. That part depends on the assistant following the tool
instructions. If you would rather not rely on that, leave search off and give
the key only the permissions you want.

## 1. Create a token

In Witness, open **Settings → Assistants and devices** and choose **Add an
assistant** (or use the last step of Setup). Give it a name you will recognize,
such as `Claude Code on my laptop`. Tick the search box only if you want it to
be able to find things you kept when you ask. The token starts with
`wit_agent_` and is shown once. Witness also shows ready-to-paste setup for the
clients below.

Treat the token like a password. Anyone with it can ask for your evidence
through the same tools. Revoke it any time in the same place.

Below, `https://witness.example.com` stands for your Witness URL.

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

Then set `WITNESS_TOKEN` to your token in your shell profile. If you prefer to
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

Ask your assistant: "What's my Witness status?" It should say whether your
sources are arriving and when the next delivery is, with no evidence. A small
number early on only means setup is new: Witness keeps things as they arrive.

## REST instead of MCP

Scripts and tools that don't speak MCP can use the REST API with the same
token:

```sh
# Status (counts only)
curl -H "Authorization: Bearer wit_agent_…" \
  https://witness.example.com/api/v1/status

# Keep something
curl -X POST https://witness.example.com/api/v1/capture \
  -H "Authorization: Bearer wit_agent_…" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"agent","text":"Thank you for covering my shift. You saved my week.","fromName":"Jordan Example","sourceLabel":"My script"}'

# Pause the rhythm for 7 days
curl -X POST https://witness.example.com/api/v1/rhythm/pause \
  -H "Authorization: Bearer wit_agent_…" \
  -H "Content-Type: application/json" \
  -d '{"days":7}'
```

Offers and reveals are available only over MCP, where the ask-first steps are
built in.

## Privacy

Status and offer calls carry no evidence. When you say yes, or ask your
assistant to search, the items it receives go to that assistant's provider
under the provider's terms. See [Privacy](../PRIVACY.md).
