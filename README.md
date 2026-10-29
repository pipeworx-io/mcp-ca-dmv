# @pipeworx/ca-dmv

California DMV data: registered vehicles and EV adoption by ZIP code, all 187 field offices with
the services each performs, the official forms catalog, insurer NAIC codes, and licensed-driver
counts by county. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this is one state per pack

Part of the `dmv` category — one pack per state motor-vehicle agency. The states do not share a
grain: California publishes a ZIP × make × model-year × fuel snapshot, New York a record-level
file, Washington monthly transaction counts, Maryland county-months, Pennsylvania county-quarters.
A single cross-state tool meant a schema where most arguments were ignored for most states and a
"total" that was never comparable, so each agency gets its own tools with its own real arguments.
For every DMV tool in one connection, use `/mcp?vertical=dmv`.

## Tools

| Tool | What it returns |
|---|---|
| `ca_dmv_vehicle_registrations` | Registered vehicle counts by ZIP, make, model year, fuel or duty class |
| `ca_dmv_ev_adoption` | Battery-electric and plug-in hybrid counts with share of the local fleet |
| `ca_dmv_offices` | All 187 field offices — address, per-day hours, coordinates, services performed |
| `ca_dmv_forms` | Official DMV forms by topic, with REG/DL form numbers and download pages |
| `ca_dmv_insurance_lookup` | Insurer NAIC codes by company name |
| `ca_dmv_driver_licenses` | Driver licenses outstanding by county, annually from 2008, plus statewide totals and ID-card count |

## Auth

None. Every endpoint is public California state infrastructure. The CKAN-backed tools accept an
optional CKAN API key, which the public datasets do not require.

## Gotchas worth knowing

Live-verified behaviours, not guesses:

- **Snapshots are one CKAN resource per year, 2019–2026**, and the rows carry the *prior*
  December 31 as their as-of date — the "2026" file describes the fleet on 2025-12-31.
- **Grouping by ZIP surfaces a literal `OOS` bucket** — out-of-state registrants, ~638k vehicles —
  which outranks every real ZIP. Ignore it when ranking ZIPs; the tool flags it in `note`.
- **`OTHER/UNK` is a real make value** that absorbs small-count suppression and can outrank
  genuine makes in a by-make ranking.
- **`total_vehicles` appears only when it is honest.** Grouping by fuel returns every category, so
  its sum is the true fleet total; any other grouping can be cut off by `limit`, and those
  responses carry `sum_of_returned_rows` plus `truncated` instead.
- **Fuel labels are specific strings** (`Battery Electric`, `Plug-in Hybrid`, `Hybrid Gasoline`,
  `Diesel and Diesel Hybrid`, `Hydrogen Fuel Cell`). Plain words like "electric", "phev" or
  "hydrogen" are mapped for you.
- **Form search uses the DMV site's own relevance ranking**, so a broad phrase like
  "title transfer" can put a vessel-title form above the vehicle one.
- **California publishes no wait-time feed.** Only North Carolina (`nc-dmv`) and Oregon (`or-dmv`)
  do; `ca_dmv_offices` returns posted hours instead.
- **Lien lookup and appointment booking are unavailable**: the lien endpoint requires a reCAPTCHA
  token and appointments run on a session-based kiosk system.

## Data sources

- [Vehicle Fuel Type Count by Zip Code](https://data.ca.gov/dataset/vehicle-fuel-type-count-by-zip-code) — data.ca.gov CKAN, `datastore_search_sql`
- [Driver Licenses Outstanding by County](https://data.ca.gov/dataset/driver-licenses-outstanding-by-county) — data.ca.gov CKAN
- [Field office directory](https://www.dmv.ca.gov/portal/wp-json/wp/v2/dmv_field-office) — dmv.ca.gov WP REST, hours and per-office service tags
- [Forms catalog](https://www.dmv.ca.gov/portal/wp-json/wp/v2/dmv_forms) — dmv.ca.gov WP REST
- Insurance carrier NAIC lookup — `https://www.dmv.ca.gov/portal/wp-json/dmv/v1/naic-lookup?s=<name>`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ca-dmv": {
      "url": "https://gateway.pipeworx.io/ca-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ca-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ca_dmv_vehicle_registrations \
  -H 'Content-Type: application/json' \
  -d '{"zip":"94002"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ca_dmv_vehicle_registrations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ca-dmv` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ca-dmv/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ca-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ca-dmv"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ca Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
