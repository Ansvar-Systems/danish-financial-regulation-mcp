# Tools Reference

This MCP server exposes 8 tools, all prefixed `dk_fin_`.

All tool responses include a `_meta` block with:
- `disclaimer` — not legal advice, verify against primary sources
- `data_age` — note that data may lag official publications
- `copyright` — data © Finanstilsynet
- `source_url` — https://www.finanstilsynet.dk/

---

## dk_fin_search_regulations

Full-text search across Finanstilsynet regulatory provisions.

**Returns:** matching bekendtgørelser (executive orders), vejledninger (guidance), and retningslinjer (guidelines).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query in Danish or English (e.g., `operationel modstandsdygtighed`, `hvidvask`, `IT-sikkerhed`) |
| `sourcebook` | string | no | Filter by sourcebook ID: `FTNET_BEKENDTGORELSER`, `FTNET_VEJLEDNINGER`, `FTNET_RETNINGSLINJER` |
| `status` | enum | no | Filter by status: `in_force`, `deleted`, `not_yet_in_force` |
| `limit` | number | no | Max results (1–100, default 20) |

**Returns:** `{ results: Provision[], count: number, _meta: Meta }`

---

## dk_fin_get_regulation

Get a specific Finanstilsynet provision by sourcebook and reference.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourcebook` | string | yes | Sourcebook ID (e.g., `FTNET_BEKENDTGORELSER`) |
| `reference` | string | yes | Full provision reference (e.g., `BEK nr 1242 af 17/11/2017`) |

**Returns:** `Provision | error`

---

## dk_fin_list_sourcebooks

List all Finanstilsynet regulatory sourcebooks with names and descriptions.

**Parameters:** none

**Returns:** `{ sourcebooks: Sourcebook[], count: number, _meta: Meta }`

---

## dk_fin_list_sources

List all data sources with full provenance metadata: source URLs, coverage scope, update frequency, license, and provision counts.

Satisfies the golden-standard `list_sources` contract.

**Parameters:** none

**Returns:** `{ sources: Source[], count: number, _meta: Meta }`

Each `Source` includes:
- `id` — sourcebook identifier
- `name` — human-readable name
- `source_url` — canonical URL at finanstilsynet.dk
- `coverage` — coverage description
- `update_frequency` — how often data is refreshed
- `license` — data license
- `provision_count` — current number of indexed provisions

---

## dk_fin_check_data_freshness

Check corpus statistics and data currency.

**Parameters:** none

**Returns:** `{ provision_count, enforcement_count, sourcebook_count, latest_provision_date, latest_enforcement_date, note, _meta }`

---

## dk_fin_search_enforcement

Search Finanstilsynet enforcement actions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (entity name, breach type, e.g., `hvidvask`) |
| `action_type` | enum | no | Filter: `fine`, `ban`, `restriction`, `warning` |
| `limit` | number | no | Max results (1–100, default 20) |

**Returns:** `{ results: EnforcementAction[], count: number, _meta: Meta }`

---

## dk_fin_check_currency

Check whether a specific provision reference is currently in force.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | yes | Full provision reference (e.g., `BEK nr 1242 af 17/11/2017`) |

**Returns:** `{ reference, status, effective_date, found, _meta }`

---

## dk_fin_about

Return server metadata: version, data source, and full tool list.

**Parameters:** none

**Returns:** `{ name, version, description, data_source, tools, _meta }`
