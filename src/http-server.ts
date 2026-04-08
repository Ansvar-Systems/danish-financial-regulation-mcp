#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  -- liveness probe
 *   POST /mcp     -- MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listSourcebooks,
  listSources,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
  checkDataFreshness,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "danish-financial-regulation-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "dk_fin_search_regulations",
    description:
      "Full-text search across Finanstilsynet regulatory provisions. Returns matching bekendtgorelser, vejledninger, and retningslinjer. Supports Danish-language queries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Danish or English (e.g., 'operationel modstandsdygtighed', 'hvidvask')" },
        sourcebook: { type: "string", description: "Filter by sourcebook ID (e.g., FTNET_BEKENDTGORELSER). Optional." },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter by provision status. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_fin_get_regulation",
    description:
      "Get a specific Finanstilsynet provision by sourcebook and reference (e.g., 'BEK nr 1242 af 17/11/2017').",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: { type: "string", description: "Sourcebook identifier (e.g., FTNET_BEKENDTGORELSER)" },
        reference: { type: "string", description: "Provision reference (e.g., 'BEK nr 1242 af 17/11/2017')" },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "dk_fin_list_sourcebooks",
    description: "List all Finanstilsynet regulatory sourcebooks with names and descriptions.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "dk_fin_search_enforcement",
    description:
      "Search Finanstilsynet enforcement actions -- administrative orders, fines, and licence revocations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (entity name, breach type, 'hvidvask')" },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filter by action type. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_fin_check_currency",
    description: "Check whether a specific Finanstilsynet provision reference is currently in force.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Provision reference to check" },
      },
      required: ["reference"],
    },
  },
  {
    name: "dk_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "dk_fin_list_sources",
    description:
      "List all data sources used by this server with provenance metadata: source URLs, coverage scope, update frequency, license, and provision counts per sourcebook.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "dk_fin_check_data_freshness",
    description:
      "Check data freshness and corpus statistics: total provision and enforcement counts, latest provision date, and staleness notes. Use before citing to understand data currency.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas ---

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// --- Meta block (golden standard) ---

const META = {
  disclaimer:
    "Regulatory data is provided for research purposes only. Not legal or regulatory advice. Verify all references against primary sources at finanstilsynet.dk before making compliance decisions.",
  data_age:
    "Data is periodically updated from official Finanstilsynet publications and may lag by days or weeks. Use dk_fin_check_data_freshness to check corpus currency.",
  copyright:
    "Regulatory data © Finanstilsynet (Danish Financial Supervisory Authority). Sourced from official public regulatory publications.",
  source_url: "https://www.finanstilsynet.dk/",
};

// --- MCP server factory ---

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      const payload =
        typeof data === "object" && data !== null
          ? { ...(data as object), _meta: META }
          : { data, _meta: META };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "dk_fin_search_regulations": {
          const parsed = SearchRegulationsArgs.parse(args);
          const results = searchProvisions({
            query: parsed.query,
            sourcebook: parsed.sourcebook,
            status: parsed.status,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "dk_fin_get_regulation": {
          const parsed = GetRegulationArgs.parse(args);
          const provision = getProvision(parsed.sourcebook, parsed.reference);
          if (!provision) {
            return errorContent(
              `Provision not found: ${parsed.sourcebook} ${parsed.reference}`,
            );
          }
          return textContent(provision);
        }

        case "dk_fin_list_sourcebooks": {
          const sourcebooks = listSourcebooks();
          return textContent({ sourcebooks, count: sourcebooks.length });
        }

        case "dk_fin_search_enforcement": {
          const parsed = SearchEnforcementArgs.parse(args);
          const results = searchEnforcement({
            query: parsed.query,
            action_type: parsed.action_type,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "dk_fin_check_currency": {
          const parsed = CheckCurrencyArgs.parse(args);
          const currency = checkProvisionCurrency(parsed.reference);
          return textContent(currency);
        }

        case "dk_fin_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "Finanstilsynet (Danish FSA) financial regulation MCP server. Provides access to bekendtgorelser (executive orders), vejledninger (guidance), retningslinjer (guidelines), and enforcement actions.",
            data_source: "Finanstilsynet regulatory publications (https://www.finanstilsynet.dk/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        case "dk_fin_list_sources": {
          const sources = listSources();
          return textContent({ sources, count: sources.length });
        }

        case "dk_fin_check_data_freshness": {
          const freshness = checkDataFreshness();
          return textContent(freshness);
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error in ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server ---

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
