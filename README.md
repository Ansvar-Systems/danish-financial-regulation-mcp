# Danish Financial Regulation MCP

MCP server for querying Finanstilsynet (Danish FSA) financial regulations. Provides access to bekendtgørelser (executive orders), vejledninger (guidance), retningslinjer (guidelines), and enforcement actions.

## Tools

| Tool | Description |
|------|-------------|
| `dk_fin_search_regulations` | Full-text search across Finanstilsynet provisions. Supports Danish-language queries. |
| `dk_fin_get_regulation` | Retrieve a specific provision by sourcebook and reference. |
| `dk_fin_list_sourcebooks` | List all Finanstilsynet regulatory sourcebooks. |
| `dk_fin_search_enforcement` | Search enforcement actions and administrative orders. |
| `dk_fin_check_currency` | Check whether a provision reference is currently in force. |
| `dk_fin_about` | Return server metadata and tool list. |

## Sourcebooks

| ID | Name |
|----|------|
| `FTNET_BEKENDTGORELSER` | Finanstilsynet Bekendtgørelser (Executive Orders) — binding regulatory rules |
| `FTNET_VEJLEDNINGER` | Finanstilsynet Vejledninger (Guidance) — supervisory expectations |
| `FTNET_RETNINGSLINJER` | Finanstilsynet Retningslinjer (Guidelines) — implementing EBA/ESMA/EIOPA guidelines |

## Data Source

Finanstilsynet regulatory publications: [https://www.finanstilsynet.dk/](https://www.finanstilsynet.dk/)

## Setup

```bash
npm install
npm run build
npm run seed         # populate sample data
npm start            # HTTP server on port 3000
```

Set `FTNET_DB_PATH` to use a custom database location (default: `data/ftnet.db`).

## Docker

```bash
docker build -t danish-financial-regulation-mcp .
docker run --rm -p 3000:3000 -v /path/to/data:/app/data danish-financial-regulation-mcp
```

## License

Apache-2.0 — Ansvar Systems AB
