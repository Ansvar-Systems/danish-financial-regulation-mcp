# Coverage

This document describes the data coverage of the Danish Financial Regulation MCP server.

## Sourcebooks

The server indexes three official Finanstilsynet (Danish Financial Supervisory Authority) regulatory sourcebooks:

### FTNET_BEKENDTGORELSER — Bekendtgørelser (Executive Orders)

- **Source URL:** https://www.finanstilsynet.dk/Regler-og-praksis/Regler/Bekendtgorelser
- **Content:** Statutory executive orders issued by Finanstilsynet under Danish financial legislation. These are legally binding secondary legislation.
- **Coverage:** All publicly listed bekendtgørelser as indexed from the Finanstilsynet website.
- **Known gaps:** Amendments to older bekendtgørelser may not always be linked. Historical documents pre-dating the current Finanstilsynet website structure may be incomplete.

### FTNET_VEJLEDNINGER — Vejledninger (Guidance)

- **Source URL:** https://www.finanstilsynet.dk/Regler-og-praksis/Regler/Vejledninger
- **Content:** Official guidance notes issued by Finanstilsynet explaining how legislation and executive orders should be interpreted and applied.
- **Coverage:** All publicly listed vejledninger as indexed from the Finanstilsynet website.
- **Known gaps:** Guidance published only as part of a consultation process or withdrawn may not be present.

### FTNET_RETNINGSLINJER — Retningslinjer (Guidelines)

- **Source URL:** https://www.finanstilsynet.dk/Regler-og-praksis/Regler/Retningslinjer
- **Content:** Regulatory guidelines and principles issued by Finanstilsynet, often implementing EBA/ESMA/EIOPA guidelines into Danish supervisory practice.
- **Coverage:** All publicly listed retningslinjer as indexed from the Finanstilsynet website.
- **Known gaps:** EBA/ESMA/EIOPA guidelines not yet formally adopted by Finanstilsynet are not included. Only the Finanstilsynet-issued version is indexed, not the underlying EU-level document.

## Enforcement Actions

Enforcement actions (administrative orders, fines, licence revocations, and public statements) are sourced from the Finanstilsynet enforcement register. Coverage includes publicly announced enforcement decisions.

**Known gaps:** Not all administrative proceedings result in a public announcement. Internal supervisory correspondence is not included.

## Data Currency

- Data is periodically refreshed by running the ingest script (`npm run ingest`).
- The corpus may lag official publications by days to weeks depending on when the last ingest was run.
- Use `dk_fin_check_data_freshness` to see corpus statistics and the date of the most recent provision.
- Always verify critical references directly at [finanstilsynet.dk](https://www.finanstilsynet.dk/).

## Out of Scope

The following are **not** covered by this MCP:

- EU-level regulations and directives (see the EU Regulations MCP)
- Danish primary legislation (lovtekster) from Retsinformation.dk
- ESMA, EBA, or EIOPA publications not adopted by Finanstilsynet
- Non-public supervisory correspondence or inspection reports
- Pension, insurance, or securities legislation not published on the Finanstilsynet regulatory pages
