# @sightline/mcp

An MCP server that gives any shopping agent Sightline's accessibility and buyer-protection functions. Claude, ChatGPT, browser agents and any other MCP client can read a purchase back to a blind shopper the safe way, check a confirmation, check a delivery against its listing, and build a signed evidence pack when the parcel is wrong.

None of the tools moves money. They produce the words, checks and evidence an agent needs before and after it pays.

## Tools

| Tool                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessible_readback`       | Builds the exact readback to speak before payment from a fixed template: item, colour, size, quantity, seller, total with shipping and tax, payment method, delivery date, returns. Totals are recomputed on the server (Demo Store tax and shipping rules unless you pass store-quoted shipping and tax). Returns `text`, the field list, totals and `text_hash`. The agent must speak `text` verbatim before asking for confirmation. |
| `check_confirmation_phrase` | Key 1 of the two-key confirmation. Decides from the words alone whether a reply is `confirm`, `hold`, `cancel`, `change` or `none`, with a reason. `payment_allowed` is always false: a second, independent key is required before money moves.                                                                                                                                                                                         |
| `verify_delivery`           | Sends photos of what arrived, plus the listing, to the vision service and returns `match`, `mismatch` or `unsure`, a reason per check with confidence in words, a headline, next steps and a spoken summary. If the service is down you get an error result, never a made-up verdict.                                                                                                                                                   |
| `build_evidence_pack`       | Builds a manifest of the order, the readback as spoken, the listing, the verdict, the narrative and a hash of each photo. Hashes it with canonical JSON and signs the hash with Ed25519.                                                                                                                                                                                                                                                |
| `verify_evidence_pack`      | Recomputes every hash, checks the signature, and optionally pins the expected key and checks photo bytes. Returns `ok` and a list of problems in plain words.                                                                                                                                                                                                                                                                           |
| `barrier_index`             | Returns the aggregated Checkout Barrier Index from `evals/results/barrier.json`: results by store platform, the most common failing rules, the number of stores and the run date. If the audit has not been run, it says so.                                                                                                                                                                                                            |

Resource: `sightline://readback-rules` is the readback and two-key confirmation rules in plain text. Point your agent at it.

## Add it to Claude Code

From anywhere, with the repo path filled in:

```sh
claude mcp add sightline -- pnpm --silent --dir /path/to/Sightline --filter @sightline/mcp stdio
```

Or commit a project-scoped `.mcp.json` at the repo root (the server then runs from the repo root):

```json
{
  "mcpServers": {
    "sightline": {
      "command": "pnpm",
      "args": ["--silent", "--filter", "@sightline/mcp", "stdio"]
    }
  }
}
```

`--silent` keeps pnpm's own messages off stdout, which carries the protocol.

## Add it to Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sightline": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/Sightline", "--filter", "@sightline/mcp", "stdio"]
    }
  }
}
```

If the app can't find `pnpm`, use its full path (`which pnpm`).

## Run over HTTP

```sh
MCP_API_KEY=change-me pnpm --filter @sightline/mcp http
```

This serves Streamable HTTP at `http://127.0.0.1:8787/mcp` in stateless mode (POST only, no sessions), plus `GET /health`. With `MCP_API_KEY` set, every request needs `Authorization: Bearer <key>`. On loopback the server only answers to local host names. Set `HOST=0.0.0.0` to expose it, and always set `MCP_API_KEY` when you do.

To connect Claude Code to it:

```sh
claude mcp add --transport http sightline http://127.0.0.1:8787/mcp --header "Authorization: Bearer change-me"
```

## Configuration

Both entry points read the repo's `.env.local` and `.env` when present. Values already in the environment win.

| Variable               | Default                      | Used for                                                                                                                                                                                  |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VISION_SERVICE_URL`   | `http://localhost:8011`      | The delivery check (`services/vision`).                                                                                                                                                   |
| `RECEIPT_SIGNING_KEY`  | none                         | Hex seed for the evidence key, derived with the `mcp-evidence` context. Without it, packs are signed with a temporary key that lasts only while the process runs, and the output says so. |
| `PORT` / `HOST`        | `8787` / `127.0.0.1`         | HTTP transport.                                                                                                                                                                           |
| `MCP_API_KEY`          | none                         | Bearer key for the HTTP transport.                                                                                                                                                        |
| `BARRIER_RESULTS_PATH` | `evals/results/barrier.json` | Where the Barrier Index results live.                                                                                                                                                     |

Like every Sightline process, the server refuses to start unless PayPal is configured for the sandbox.

## Photos and images

`verify_delivery` takes photos as base64 or as https URLs. URLs must resolve to a public address and are fetched without redirects, up to 10 MB each. Listing images can be https URLs, which the vision service fetches itself, or Demo Store paths such as `/demo-store/harbor-knit-crew--navy.png`, which are read from `apps/web/public`.

## Scripts

```sh
pnpm --filter @sightline/mcp stdio      # stdio server
pnpm --filter @sightline/mcp http       # Streamable HTTP server
pnpm --filter @sightline/mcp test       # vitest: tools over an in-memory client, HTTP and stdio
pnpm --filter @sightline/mcp typecheck
```
