#!/usr/bin/env tsx
/**
 * Finanstilsynet ingestion crawler for the Danish Financial Regulation MCP.
 *
 * Crawls three data sources:
 *   1. Finanstilsynet "Dansk lovsamling" index pages  → bekendtgørelser and vejledninger
 *      (links out to retsinformation.dk for full text)
 *   2. Retsinformation community API                  → structured law content (chapters, sections)
 *   3. Finanstilsynet "Inspektion og afgørelser" pages → enforcement actions
 *
 * The crawler populates the three sourcebooks defined in db.ts:
 *   - FTNET_BEKENDTGORELSER  (binding executive orders)
 *   - FTNET_VEJLEDNINGER     (non-binding supervisory guidance)
 *   - FTNET_RETNINGSLINJER   (guidelines implementing EBA/ESMA/EIOPA)
 *
 * And the enforcement_actions table with inspection reports, fines, and orders.
 *
 * Usage:
 *   npx tsx scripts/ingest-finanstilsynet.ts
 *   npx tsx scripts/ingest-finanstilsynet.ts --dry-run
 *   npx tsx scripts/ingest-finanstilsynet.ts --resume
 *   npx tsx scripts/ingest-finanstilsynet.ts --force
 *
 * Flags:
 *   --dry-run   Crawl and log what would be inserted, but do not write to DB
 *   --resume    Skip provisions/enforcement that already exist in the DB
 *   --force     Drop all data and re-ingest from scratch
 *
 * Environment:
 *   FTNET_DB_PATH   Path to the SQLite database (default: data/ftnet.db)
 *
 * Rate limit: 1500 ms between HTTP requests (respects Finanstilsynet and
 * retsinformation.dk server load).
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["FTNET_DB_PATH"] ?? "data/ftnet.db";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;
const USER_AGENT =
  "Ansvar-Finanstilsynet-MCP/1.0 (https://github.com/Ansvar-Systems/danish-financial-regulation-mcp)";

const PROGRESS_FILE = resolve(dirname(DB_PATH), ".ingest-progress.json");

/** Community Retsinformation API — structured legislation content. */
const RETSINFORMATION_API = "https://retsinformation-api.dk/v1/lovgivning";

/** Finanstilsynet website base URL. */
const FTNET_BASE = "https://www.finanstilsynet.dk";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProgressState {
  /** Retsinformation document references already ingested. */
  provisions_done: string[];
  /** Enforcement page URLs already ingested. */
  enforcement_done: string[];
}

interface LegislationLink {
  reference: string; // e.g. "BEK nr 1242 af 17/11/2017"
  title: string;
  url: string; // retsinformation.dk URL
  type: "bekendtgorelse" | "vejledning" | "retningslinje";
  sourcebook_id: string;
  sector: string; // originating index page category
}

interface RetsinformationProvision {
  reference: string;
  title: string | null;
  text: string;
  chapter: string | null;
  section: string | null;
}

interface RetsinformationDocument {
  title: string;
  status: string;
  effective_date: string | null;
  provisions: RetsinformationProvision[];
}

interface EnforcementEntry {
  firm_name: string;
  reference_number: string | null;
  action_type: string | null;
  amount: number;
  date: string | null;
  summary: string;
  url: string;
  sourcebook_references: string | null;
}

// ---------------------------------------------------------------------------
// Sourcebook definitions
// ---------------------------------------------------------------------------

const SOURCEBOOKS = [
  {
    id: "FTNET_BEKENDTGORELSER",
    name: "Finanstilsynet Bekendtgorelser (Executive Orders)",
    description:
      "Bindende bekendtgorelser udstedt af Finanstilsynet i medfor af dansk finansiel lovgivning. Daekker governance, kapitalgrundlag, indberetning, forbrugerbeskyttelse og AML/CFT-krav for kreditinstitutter, fondsmaeglere, forsikringsselskaber og betalingstjenesteudbydere.",
  },
  {
    id: "FTNET_VEJLEDNINGER",
    name: "Finanstilsynet Vejledninger (Guidance)",
    description:
      "Ikke-bindende tilsynsvejledninger udstedt af Finanstilsynet om fortolkning og anvendelse af dansk finansiel regulering. Daekker operationel modstandsdygtighed, IT-sikkerhed, outsourcing, risikostyring og tilsynsforventninger for regulerede enheder.",
  },
  {
    id: "FTNET_RETNINGSLINJER",
    name: "Finanstilsynet Retningslinjer (Guidelines)",
    description:
      "Finanstilsynets retningslinjer, der implementerer EBA-, ESMA- og EIOPA-retningslinjer i dansk tilsynspraksis. Omfatter ogsaa sektorspecifikke retningslinjer om cyberrobusthed, genopretningsplaner og aflonning.",
  },
];

// ---------------------------------------------------------------------------
// Finanstilsynet lovsamling index pages — organised by regulatory sector
// ---------------------------------------------------------------------------

const LOVSAMLING_PAGES: Array<{ url: string; sector: string }> = [
  { url: "/lovgivning/dansk-lovsamling/tvaergaaende", sector: "Tvaergaaende" },
  {
    url: "/lovgivning/dansk-lovsamling/kreditinstitutomraadet",
    sector: "Kreditinstitutter",
  },
  {
    url: "/lovgivning/dansk-lovsamling/forsikringsomraadet",
    sector: "Forsikring",
  },
  {
    url: "/lovgivning/dansk-lovsamling/kapitalmarkedsomraadet",
    sector: "Kapitalmarked",
  },
  {
    url: "/lovgivning/dansk-lovsamling/betalingstjenesteomraadet",
    sector: "Betalingstjenester",
  },
  {
    url: "/lovgivning/dansk-lovsamling/hvidvaskomraadet",
    sector: "Hvidvask",
  },
  {
    url: "/lovgivning/dansk-lovsamling/andre-tilsynslove",
    sector: "Andre tilsynslove",
  },
];

/**
 * Enforcement decision listing — year/month pages under /tilsyn/inspektion-og-afgoerelser.
 * We generate URLs for the years we want to crawl.
 */
const ENFORCEMENT_START_YEAR = 2018;
const ENFORCEMENT_END_YEAR = new Date().getFullYear();
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  accept: string = "text/html",
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          Accept: accept,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "10");
        log(`  429 rate-limited on ${url}, waiting ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(retryAfter * 1_000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        log(`  Retry ${attempt}/${MAX_RETRIES} for ${url}: ${lastError.message} (backoff ${backoff}ms)`);
        await sleep(backoff);
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url} after ${MAX_RETRIES} attempts`);
}

async function fetchHtml(url: string): Promise<string> {
  const response = await rateLimitedFetch(url, "text/html");
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await rateLimitedFetch(url, "application/json");
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${message}`);
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

/**
 * Parse a Danish date string (DD/MM/YYYY) to ISO format (YYYY-MM-DD).
 */
function parseDanishDate(dateStr: string): string | null {
  const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) {
    // Try ISO format already
    const isoMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return isoMatch[0];
    return null;
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * Parse a "DD-MM-YYYY" or "DD. month YYYY" date from enforcement pages.
 */
function parseEnforcementDate(text: string): string | null {
  // Try DD-MM-YYYY
  const dashed = text.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dashed) {
    return `${dashed[3]}-${dashed[2]!.padStart(2, "0")}-${dashed[1]!.padStart(2, "0")}`;
  }

  // Try DD. month YYYY (Danish month names)
  const danishMonths: Record<string, string> = {
    januar: "01", februar: "02", marts: "03", april: "04",
    maj: "05", juni: "06", juli: "07", august: "08",
    september: "09", oktober: "10", november: "11", december: "12",
  };
  const named = text.match(
    /(\d{1,2})\.\s*(januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)\s+(\d{4})/i,
  );
  if (named) {
    const month = danishMonths[named[2]!.toLowerCase()];
    if (month) {
      return `${named[3]}-${month}-${named[1]!.padStart(2, "0")}`;
    }
  }

  // Try DD/MM/YYYY
  return parseDanishDate(text);
}

/**
 * Extract the retsinformation.dk document year and number from a URL.
 * Handles:
 *   - https://www.retsinformation.dk/eli/lta/2025/658
 *   - https://www.retsinformation.dk/eli/retsinfo/2020/9771
 *   - https://www.retsinformation.dk/Forms/R0710.aspx?id=177565
 */
function parseRetsinformationUrl(url: string): {
  year: number | null;
  number: number | null;
  legacyId: string | null;
} {
  // Modern ELI format
  const eli = url.match(/\/eli\/(?:lta|retsinfo)\/(\d{4})\/(\d+)/);
  if (eli) {
    return {
      year: Number(eli[1]),
      number: Number(eli[2]),
      legacyId: null,
    };
  }

  // Legacy format
  const legacy = url.match(/[?&]id=(\d+)/);
  if (legacy) {
    return { year: null, number: null, legacyId: legacy[1]! };
  }

  return { year: null, number: null, legacyId: null };
}

// ---------------------------------------------------------------------------
// Progress tracking (for --resume)
// ---------------------------------------------------------------------------

function loadProgress(): ProgressState {
  if (existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as ProgressState;
      return {
        provisions_done: data.provisions_done ?? [],
        enforcement_done: data.enforcement_done ?? [],
      };
    } catch {
      return { provisions_done: [], enforcement_done: [] };
    }
  }
  return { provisions_done: [], enforcement_done: [] };
}

function saveProgress(state: ProgressState): void {
  const dir = dirname(PROGRESS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 1: Crawl Finanstilsynet lovsamling index pages
// ---------------------------------------------------------------------------

/**
 * Scrape a single lovsamling index page and extract links to bekendtgørelser,
 * vejledninger, and retningslinjer on retsinformation.dk.
 */
async function scrapeLovsamlingPage(
  pageUrl: string,
  sector: string,
): Promise<LegislationLink[]> {
  const fullUrl = pageUrl.startsWith("http")
    ? pageUrl
    : `${FTNET_BASE}${pageUrl}`;
  log(`  Fetching lovsamling page: ${fullUrl}`);

  const html = await fetchHtml(fullUrl);
  const $ = cheerio.load(html);
  const links: LegislationLink[] = [];

  // The page uses <h3> headings to separate Love, Bekendtgørelser, Vejledninger.
  // Links to retsinformation.dk follow the pattern:
  //   "BEK nr 658 af 23/05/2025 - <a href='...'>Title</a>"
  // We iterate all anchor tags pointing at retsinformation.dk and
  // use the preceding text node to extract the reference.

  let currentHeading = "";

  // Walk through the main content area
  const contentArea = $("main, .content, article, .page-content, body");
  contentArea.find("h3, h2, a").each((_i, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();

    if (tag === "h3" || tag === "h2") {
      currentHeading = normalizeWhitespace($(el).text()).toLowerCase();
      return;
    }

    if (tag === "a") {
      const href = $(el).attr("href") ?? "";
      if (!href.includes("retsinformation.dk")) return;

      const linkTitle = normalizeWhitespace($(el).text());
      if (!linkTitle) return;

      // Extract the reference from the text preceding the link.
      // The parent text typically looks like:
      //   "BEK nr 1242 af 17/11/2017 - God skik for ..."
      const parentText = normalizeWhitespace(
        $(el).parent().text(),
      );

      // Match the reference pattern: TYPE nr NUMBER af DD/MM/YYYY
      const refMatch = parentText.match(
        /((?:BEK|VEJ|CIR|LOV|LBK|FOR)\s+nr\s+\d+\s+af\s+\d{2}\/\d{2}\/\d{4})/i,
      );
      const reference = refMatch
        ? normalizeWhitespace(refMatch[1]!)
        : linkTitle;

      // Determine type from heading context and reference prefix
      let type: LegislationLink["type"] = "bekendtgorelse";
      let sourcebook_id = "FTNET_BEKENDTGORELSER";

      const refUpper = reference.toUpperCase();
      if (
        currentHeading.includes("vejledning") ||
        refUpper.startsWith("VEJ")
      ) {
        type = "vejledning";
        sourcebook_id = "FTNET_VEJLEDNINGER";
      } else if (
        currentHeading.includes("retningslinje") ||
        currentHeading.includes("guideline")
      ) {
        type = "retningslinje";
        sourcebook_id = "FTNET_RETNINGSLINJER";
      }

      // Normalise the URL
      let normalUrl = href;
      if (normalUrl.startsWith("//")) normalUrl = `https:${normalUrl}`;
      if (normalUrl.startsWith("http://"))
        normalUrl = normalUrl.replace("http://", "https://");

      links.push({
        reference,
        title: linkTitle,
        url: normalUrl,
        type,
        sourcebook_id,
        sector,
      });
    }
  });

  log(`    Found ${links.length} legislation links in sector "${sector}"`);
  return links;
}

/**
 * Crawl all lovsamling index pages and collect a deduplicated list of
 * legislation links.
 */
async function collectAllLegislationLinks(): Promise<LegislationLink[]> {
  log("Phase 1: Crawling Finanstilsynet lovsamling index pages");

  const allLinks: LegislationLink[] = [];
  const seen = new Set<string>();

  for (const page of LOVSAMLING_PAGES) {
    try {
      const links = await scrapeLovsamlingPage(page.url, page.sector);
      for (const link of links) {
        // Deduplicate by URL
        if (!seen.has(link.url)) {
          seen.add(link.url);
          allLinks.push(link);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  WARNING: Failed to scrape ${page.url}: ${msg}`);
    }
  }

  log(`Phase 1 complete: ${allLinks.length} unique legislation links collected`);
  return allLinks;
}

// ---------------------------------------------------------------------------
// Phase 2: Fetch full provision text from retsinformation-api.dk
// ---------------------------------------------------------------------------

/**
 * Fetch structured legislation content from the community Retsinformation API.
 * Falls back to scraping retsinformation.dk HTML if the API does not have the document.
 */
async function fetchProvisionContent(
  link: LegislationLink,
): Promise<RetsinformationDocument | null> {
  const parsed = parseRetsinformationUrl(link.url);

  // Try the community API first (structured JSON with chapters/sections)
  if (parsed.year && parsed.number) {
    try {
      return await fetchFromRetsinformationApi(parsed.year, parsed.number, link);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    API fetch failed for ${link.reference}, falling back to HTML scrape: ${msg}`);
    }
  }

  // Fall back to scraping retsinformation.dk HTML
  try {
    return await scrapeRetsinformationHtml(link);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`    HTML scrape also failed for ${link.reference}: ${msg}`);
    return null;
  }
}

/**
 * Fetch from retsinformation-api.dk community API.
 */
async function fetchFromRetsinformationApi(
  year: number,
  number: number,
  link: LegislationLink,
): Promise<RetsinformationDocument> {
  // Fetch the latest version with full structure
  const url = `${RETSINFORMATION_API}/${year}/${number}/versions/latest`;
  log(`    Fetching API: ${url}`);

  const data = await fetchJson<Record<string, unknown>>(url);

  const title =
    typeof data["title"] === "string"
      ? normalizeWhitespace(data["title"])
      : link.title;

  const status = inferStatus(data);
  const effectiveDate =
    typeof data["effective_date"] === "string"
      ? data["effective_date"]
      : typeof data["in_force_date"] === "string"
        ? data["in_force_date"]
        : null;

  // Extract provisions from the structured content
  const provisions = extractProvisionsFromApiResponse(data, link.reference);

  return {
    title,
    status,
    effective_date: effectiveDate,
    provisions,
  };
}

/**
 * Walk the API response structure and extract individual provisions
 * (paragraphs / sections).
 */
function extractProvisionsFromApiResponse(
  data: Record<string, unknown>,
  baseReference: string,
): RetsinformationProvision[] {
  const provisions: RetsinformationProvision[] = [];

  // The API returns structured content with chapters and paragraphs.
  // Walk through the structure tree.
  const structure = data["structure"] ?? data["content"] ?? data;

  function walkNode(
    node: unknown,
    currentChapter: string | null,
  ): void {
    if (node == null) return;

    if (Array.isArray(node)) {
      for (const item of node) walkNode(item, currentChapter);
      return;
    }

    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // Check if this node is a chapter
    const nodeType = typeof obj["type"] === "string" ? obj["type"] : "";
    if (
      nodeType === "chapter" ||
      nodeType === "kapitel" ||
      typeof obj["chapter_number"] === "string" ||
      typeof obj["chapter_number"] === "number"
    ) {
      const chapNum =
        String(obj["chapter_number"] ?? obj["number"] ?? obj["id"] ?? "").trim();
      const nextChapter = chapNum || currentChapter;

      // Process children
      const children = obj["children"] ?? obj["paragraphs"] ?? obj["sections"];
      if (children) walkNode(children, nextChapter);
      return;
    }

    // Check if this node is a paragraph/section
    if (
      nodeType === "paragraph" ||
      nodeType === "paragraf" ||
      nodeType === "section" ||
      typeof obj["paragraph_number"] === "string" ||
      typeof obj["paragraph_number"] === "number"
    ) {
      const secNum =
        String(
          obj["paragraph_number"] ?? obj["section_number"] ?? obj["number"] ?? "",
        ).trim();
      const title =
        typeof obj["title"] === "string"
          ? normalizeWhitespace(obj["title"])
          : typeof obj["heading"] === "string"
            ? normalizeWhitespace(obj["heading"])
            : null;

      // Collect all text content
      let text = "";
      if (typeof obj["text"] === "string") {
        text = normalizeWhitespace(obj["text"]);
      } else if (typeof obj["content"] === "string") {
        text = normalizeWhitespace(obj["content"]);
      } else if (typeof obj["markdown"] === "string") {
        text = normalizeWhitespace(obj["markdown"]);
      } else {
        // Collect text from subsections (stk)
        const stks = obj["stk"] ?? obj["subsections"] ?? obj["children"];
        if (Array.isArray(stks)) {
          const parts: string[] = [];
          for (const stk of stks) {
            if (typeof stk === "string") {
              parts.push(stk);
            } else if (typeof stk === "object" && stk !== null) {
              const stkObj = stk as Record<string, unknown>;
              const stkText =
                typeof stkObj["text"] === "string"
                  ? stkObj["text"]
                  : typeof stkObj["content"] === "string"
                    ? stkObj["content"]
                    : "";
              if (stkText) parts.push(normalizeWhitespace(stkText));
            }
          }
          text = parts.join(" ");
        }
      }

      if (text && secNum) {
        const ref = currentChapter
          ? `${baseReference}, kap. ${currentChapter}, § ${secNum}`
          : `${baseReference}, § ${secNum}`;

        provisions.push({
          reference: ref,
          title,
          text,
          chapter: currentChapter,
          section: secNum,
        });
      }

      // Also recurse children in case there are nested sections
      const children = obj["children"] ?? obj["subsections"];
      if (children) walkNode(children, currentChapter);
      return;
    }

    // Generic walk for any other structure
    for (const [key, value] of Object.entries(obj)) {
      if (
        key === "type" ||
        key === "id" ||
        key === "number" ||
        key === "title" ||
        key === "heading"
      ) {
        continue;
      }
      walkNode(value, currentChapter);
    }
  }

  walkNode(structure, null);

  // If structured extraction found nothing, create a single provision from
  // whatever text content is available at the top level.
  if (provisions.length === 0) {
    const topText =
      typeof (data as Record<string, unknown>)["text"] === "string"
        ? normalizeWhitespace((data as Record<string, unknown>)["text"] as string)
        : typeof (data as Record<string, unknown>)["markdown"] === "string"
          ? normalizeWhitespace((data as Record<string, unknown>)["markdown"] as string)
          : null;

    if (topText && topText.length > 20) {
      provisions.push({
        reference: baseReference,
        title: null,
        text: topText,
        chapter: null,
        section: "1",
      });
    }
  }

  return provisions;
}

/**
 * Scrape the retsinformation.dk HTML page directly when the API is unavailable.
 */
async function scrapeRetsinformationHtml(
  link: LegislationLink,
): Promise<RetsinformationDocument> {
  log(`    Fetching HTML: ${link.url}`);
  const html = await fetchHtml(link.url);
  const $ = cheerio.load(html);

  const title =
    normalizeWhitespace($("h1").first().text()) || link.title;

  // The main content is inside #LovNummereringOuter or .markup-LovParagraf
  const bodySelector = "#LovNummereringOuter, .markup-LovText, .LovText, #LovDokument, main, article";
  const bodyEl = $(bodySelector).first();
  const bodyText = bodyEl.length
    ? normalizeWhitespace(bodyEl.text())
    : normalizeWhitespace($("body").text());

  // Try to extract individual paragraphs (§-based)
  const provisions: RetsinformationProvision[] = [];
  let currentChapter: string | null = null;

  $(".markup-LovKapitel, .kapitelOverskrift, h2, h3").each((_i, el) => {
    const headingText = normalizeWhitespace($(el).text());
    const chapMatch = headingText.match(/kapitel\s+(\d+[a-z]?)/i);
    if (chapMatch) {
      currentChapter = chapMatch[1]!;
    }
  });

  // Look for § markers in the HTML structure
  $(".markup-LovParagraf, .paragraf, [id^='P']").each((_i, el) => {
    const elText = normalizeWhitespace($(el).text());
    const paraMatch = elText.match(/§\s*(\d+[a-z]?)/i);
    if (paraMatch && elText.length > 30) {
      const secNum = paraMatch[1]!;
      const ref = currentChapter
        ? `${link.reference}, kap. ${currentChapter}, § ${secNum}`
        : `${link.reference}, § ${secNum}`;

      provisions.push({
        reference: ref,
        title: null,
        text: elText,
        chapter: currentChapter,
        section: secNum,
      });
    }
  });

  // If no structured paragraphs found, store the full text as one provision
  if (provisions.length === 0 && bodyText.length > 50) {
    provisions.push({
      reference: link.reference,
      title: null,
      text: bodyText.slice(0, 50_000), // cap at 50K chars
      chapter: null,
      section: "1",
    });
  }

  // Attempt to find effective date from metadata
  let effectiveDate: string | null = null;
  const refDateMatch = link.reference.match(/af\s+(\d{2}\/\d{2}\/\d{4})/);
  if (refDateMatch) {
    effectiveDate = parseDanishDate(refDateMatch[1]!);
  }

  return {
    title,
    status: "in_force",
    effective_date: effectiveDate,
    provisions,
  };
}

function inferStatus(data: Record<string, unknown>): string {
  const raw = String(data["status"] ?? data["state"] ?? "").toLowerCase();
  if (raw.includes("historisk") || raw.includes("repealed") || raw.includes("ophævet")) {
    return "repealed";
  }
  if (raw.includes("gaeldende") || raw.includes("gældende") || raw.includes("in_force")) {
    return "in_force";
  }
  return "in_force";
}

// ---------------------------------------------------------------------------
// Phase 3: Crawl enforcement actions from Finanstilsynet
// ---------------------------------------------------------------------------

/**
 * Generate enforcement listing URLs for year/month pages.
 */
function generateEnforcementListingUrls(): string[] {
  const urls: string[] = [];
  for (let year = ENFORCEMENT_START_YEAR; year <= ENFORCEMENT_END_YEAR; year++) {
    for (const month of MONTHS) {
      urls.push(
        `${FTNET_BASE}/tilsyn/inspektion-og-afgoerelser/${year}/${month}`,
      );
    }
  }
  return urls;
}

/**
 * Scrape a monthly enforcement listing page and return links to individual decisions.
 */
async function scrapeEnforcementListing(
  listingUrl: string,
): Promise<Array<{ url: string; title: string }>> {
  let html: string;
  try {
    html = await fetchHtml(listingUrl);
  } catch {
    // Month pages that don't exist return 404 — skip silently
    return [];
  }

  const $ = cheerio.load(html);
  const results: Array<{ url: string; title: string }> = [];

  // Individual decisions are linked as anchors within the listing.
  // URL pattern: /tilsyn/inspektion-og-afgoerelser/YYYY/mmm/slug
  $("a").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (
      href.includes("/tilsyn/inspektion-og-afgoerelser/") &&
      href.split("/").length > 5 // Must have a slug after year/month
    ) {
      const title = normalizeWhitespace($(el).text());
      if (title.length > 5) {
        const fullUrl = href.startsWith("http")
          ? href
          : `${FTNET_BASE}${href}`;
        results.push({ url: fullUrl, title });
      }
    }
  });

  return results;
}

/**
 * Scrape an individual enforcement decision page.
 */
async function scrapeEnforcementPage(
  url: string,
  listingTitle: string,
): Promise<EnforcementEntry | null> {
  log(`    Fetching enforcement page: ${url}`);

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`    WARNING: Failed to fetch enforcement page ${url}: ${msg}`);
    return null;
  }

  const $ = cheerio.load(html);

  // Title — from <h1> or listing title
  const pageTitle =
    normalizeWhitespace($("h1").first().text()) || listingTitle;

  // Extract firm name from title.
  // Titles typically follow: "Redegoerelse om inspektion i [FIRM NAME]"
  // or "Afgorelse om [topic] vedr. [FIRM NAME]"
  let firmName = "Ukendt virksomhed";
  const firmPatterns = [
    /inspektion\s+i\s+(.+?)$/i,
    /vedr(?:ørende|\.)\s+(.+?)$/i,
    /(?:om|til)\s+(.+?)\s*$/i,
  ];
  for (const pattern of firmPatterns) {
    const match = pageTitle.match(pattern);
    if (match) {
      firmName = normalizeWhitespace(match[1]!);
      break;
    }
  }

  // Date — look for date text near the title
  let date: string | null = null;
  const bodyText = $("body").text();
  // Check URL for year/month hint
  const urlDateMatch = url.match(
    /inspektion-og-afgoerelser\/(\d{4})\/(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)/,
  );
  if (urlDateMatch) {
    const monthMap: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04",
      maj: "05", jun: "06", jul: "07", aug: "08",
      sep: "09", okt: "10", nov: "11", dec: "12",
    };
    const yearStr = urlDateMatch[1]!;
    const monthStr = monthMap[urlDateMatch[2]!] ?? "01";
    // Try to find the exact day in the page text
    const dayMatch = bodyText.match(
      new RegExp(
        `(\\d{1,2})\\.?\\s*(?:${urlDateMatch[2]![0]!.toUpperCase() + urlDateMatch[2]!.slice(1)}|\\d{1,2})`,
        "i",
      ),
    );
    const day = dayMatch ? dayMatch[1]!.padStart(2, "0") : "15";
    date = `${yearStr}-${monthStr}-${day}`;
  }

  // Also try parsing a date from visible date stamps in the page
  const dateInPage = bodyText.match(
    /(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})/,
  );
  if (dateInPage) {
    const parsed = parseEnforcementDate(dateInPage[0]);
    if (parsed) date = parsed;
  }

  // Action type — infer from title keywords
  let actionType = "inspektionsredegoerelse";
  const titleLower = pageTitle.toLowerCase();
  if (titleLower.includes("bode") || titleLower.includes("bøde")) {
    actionType = "fine";
  } else if (titleLower.includes("paabud") || titleLower.includes("påbud")) {
    actionType = "restriction";
  } else if (titleLower.includes("politianmeldelse")) {
    actionType = "politianmeldelse";
  } else if (titleLower.includes("advarsel")) {
    actionType = "advarsel";
  } else if (titleLower.includes("paatale") || titleLower.includes("påtale")) {
    actionType = "paatale";
  } else if (titleLower.includes("regnskabskontrol")) {
    actionType = "regnskabskontrol";
  } else if (titleLower.includes("afgorelse") || titleLower.includes("afgørelse")) {
    actionType = "afgorelse";
  } else if (
    titleLower.includes("redegoerelse") ||
    titleLower.includes("redegørelse") ||
    titleLower.includes("inspektion")
  ) {
    actionType = "inspektionsredegoerelse";
  }

  // Summary — extract first few paragraphs of the main content.
  // Try finding "Sammenfatning" section first, then fall back to body text.
  let summary = "";
  const summaryHeader = $("h2, h3").filter((_i, el) => {
    const text = $(el).text().toLowerCase();
    return (
      text.includes("sammenfatning") ||
      text.includes("risikovurdering") ||
      text.includes("konklusion")
    );
  });

  if (summaryHeader.length) {
    // Collect text from elements after the summary heading until the next heading
    let sibling = summaryHeader.first().next();
    const parts: string[] = [];
    while (sibling.length && !sibling.is("h2, h3")) {
      const txt = normalizeWhitespace(sibling.text());
      if (txt.length > 10) parts.push(txt);
      sibling = sibling.next();
    }
    summary = parts.join(" ");
  }

  if (!summary) {
    // Fall back to first ~2000 chars of paragraph content
    const paragraphs: string[] = [];
    $("p").each((_i, el) => {
      const txt = normalizeWhitespace($(el).text());
      if (txt.length > 20) paragraphs.push(txt);
    });
    summary = paragraphs.slice(0, 8).join(" ");
  }

  // Cap summary length
  if (summary.length > 5_000) {
    summary = summary.slice(0, 5_000) + "...";
  }

  if (!summary) return null;

  // Extract referenced sourcebook provisions (BEK/VEJ/CIR references)
  const sourcebookRefs: string[] = [];
  const refPattern =
    /(?:BEK|VEJ|CIR|LOV|LBK)\s+nr\s+\d+\s+af\s+\d{2}\/\d{2}\/\d{4}/gi;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refPattern.exec(bodyText)) !== null) {
    const ref = normalizeWhitespace(refMatch[0]);
    if (!sourcebookRefs.includes(ref)) sourcebookRefs.push(ref);
  }

  // Reference number — derive from URL slug
  const slugMatch = url.match(
    /inspektion-og-afgoerelser\/(\d{4})\/(\w+)\/(.+?)(?:\/|$)/,
  );
  const refNumber = slugMatch
    ? `FTNET/${slugMatch[1]}/${slugMatch[2]?.toUpperCase()}/${slugMatch[3]}`
    : null;

  return {
    firm_name: firmName,
    reference_number: refNumber,
    action_type: actionType,
    amount: 0,
    date,
    summary,
    url,
    sourcebook_references: sourcebookRefs.length
      ? sourcebookRefs.join("; ")
      : null,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function insertSourcebooks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  for (const sb of SOURCEBOOKS) {
    stmt.run(sb.id, sb.name, sb.description);
  }
  log(`Sourcebooks ensured: ${SOURCEBOOKS.length}`);
}

function provisionExists(
  db: Database.Database,
  sourcebookId: string,
  reference: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM provisions WHERE sourcebook_id = ? AND reference = ? LIMIT 1",
    )
    .get(sourcebookId, reference) as { "1": number } | undefined;
  return row !== undefined;
}

function enforcementExists(
  db: Database.Database,
  referenceNumber: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM enforcement_actions WHERE reference_number = ? LIMIT 1",
    )
    .get(referenceNumber) as { "1": number } | undefined;
  return row !== undefined;
}

function insertProvision(
  db: Database.Database,
  sourcebookId: string,
  reference: string,
  title: string | null,
  text: string,
  type: string,
  status: string,
  effectiveDate: string | null,
  chapter: string | null,
  section: string | null,
): void {
  db.prepare(
    `INSERT INTO provisions
       (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourcebookId, reference, title, text, type, status, effectiveDate, chapter, section);
}

function insertEnforcement(
  db: Database.Database,
  entry: EnforcementEntry,
): void {
  db.prepare(
    `INSERT INTO enforcement_actions
       (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.firm_name,
    entry.reference_number,
    entry.action_type,
    entry.amount,
    entry.date,
    entry.summary,
    entry.sourcebook_references,
  );
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("=== Finanstilsynet Ingestion Crawler ===");
  log(`Database:  ${DB_PATH}`);
  log(`Flags:     ${DRY_RUN ? "--dry-run " : ""}${RESUME ? "--resume " : ""}${FORCE ? "--force " : ""}`);
  log("");

  const db = DRY_RUN ? null : initDatabase();
  if (db) insertSourcebooks(db);

  const progress = RESUME ? loadProgress() : { provisions_done: [], enforcement_done: [] };
  const provisionsDone = new Set(progress.provisions_done);
  const enforcementDone = new Set(progress.enforcement_done);

  // ----- Phase 1 + 2: Legislation -----
  log("");
  log("=== Phase 1+2: Legislation (bekendtgorelser, vejledninger, retningslinjer) ===");

  const links = await collectAllLegislationLinks();

  let provisionsInserted = 0;
  let provisionsSkipped = 0;
  let legislationErrors = 0;

  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const pct = (((i + 1) / links.length) * 100).toFixed(1);
    log(`[${i + 1}/${links.length}] (${pct}%) Processing: ${link.reference}`);

    // Resume check
    if (RESUME && provisionsDone.has(link.reference)) {
      log(`  Skipped (already ingested)`);
      provisionsSkipped++;
      continue;
    }

    // Check DB for existing data
    if (RESUME && db && provisionExists(db, link.sourcebook_id, link.reference)) {
      log(`  Skipped (already in DB)`);
      provisionsDone.add(link.reference);
      provisionsSkipped++;
      continue;
    }

    try {
      const doc = await fetchProvisionContent(link);
      if (!doc || doc.provisions.length === 0) {
        log(`  No provisions extracted for ${link.reference}`);
        legislationErrors++;
        continue;
      }

      log(`  Extracted ${doc.provisions.length} provision(s) — "${doc.title}"`);

      if (!DRY_RUN && db) {
        const insertBatch = db.transaction(() => {
          for (const prov of doc.provisions) {
            insertProvision(
              db,
              link.sourcebook_id,
              prov.reference,
              prov.title ?? link.title,
              prov.text,
              link.type,
              doc.status,
              doc.effective_date,
              prov.chapter,
              prov.section,
            );
          }
        });
        insertBatch();
        provisionsInserted += doc.provisions.length;
      } else {
        provisionsInserted += doc.provisions.length;
      }

      provisionsDone.add(link.reference);
      if (RESUME && !DRY_RUN) {
        progress.provisions_done = [...provisionsDone];
        saveProgress(progress);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR processing ${link.reference}: ${msg}`);
      legislationErrors++;
    }
  }

  log("");
  log(`Legislation summary:`);
  log(`  Links found:        ${links.length}`);
  log(`  Provisions inserted: ${provisionsInserted}`);
  log(`  Skipped (resume):   ${provisionsSkipped}`);
  log(`  Errors:             ${legislationErrors}`);

  // ----- Phase 3: Enforcement actions -----
  log("");
  log("=== Phase 3: Enforcement actions ===");

  const enforcementListingUrls = generateEnforcementListingUrls();
  let enforcementInserted = 0;
  let enforcementSkipped = 0;
  let enforcementErrors = 0;
  let totalDecisionLinks = 0;

  for (let i = 0; i < enforcementListingUrls.length; i++) {
    const listingUrl = enforcementListingUrls[i]!;
    const pct = (((i + 1) / enforcementListingUrls.length) * 100).toFixed(1);

    let decisionLinks: Array<{ url: string; title: string }>;
    try {
      decisionLinks = await scrapeEnforcementListing(listingUrl);
    } catch {
      continue;
    }

    if (decisionLinks.length === 0) continue;

    log(
      `[${i + 1}/${enforcementListingUrls.length}] (${pct}%) ${listingUrl} — ${decisionLinks.length} decision(s)`,
    );
    totalDecisionLinks += decisionLinks.length;

    for (const decisionLink of decisionLinks) {
      // Resume check
      if (RESUME && enforcementDone.has(decisionLink.url)) {
        enforcementSkipped++;
        continue;
      }

      if (
        RESUME &&
        db &&
        decisionLink.url.includes("/") &&
        enforcementExists(db, decisionLink.url)
      ) {
        enforcementDone.add(decisionLink.url);
        enforcementSkipped++;
        continue;
      }

      try {
        const entry = await scrapeEnforcementPage(
          decisionLink.url,
          decisionLink.title,
        );

        if (!entry) {
          enforcementErrors++;
          continue;
        }

        log(`    -> ${entry.action_type}: ${entry.firm_name} (${entry.date ?? "unknown date"})`);

        if (!DRY_RUN && db) {
          insertEnforcement(db, entry);
          enforcementInserted++;
        } else {
          enforcementInserted++;
        }

        enforcementDone.add(decisionLink.url);
        if (RESUME && !DRY_RUN) {
          progress.enforcement_done = [...enforcementDone];
          saveProgress(progress);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`    ERROR: ${msg}`);
        enforcementErrors++;
      }
    }
  }

  log("");
  log(`Enforcement summary:`);
  log(`  Listing pages checked: ${enforcementListingUrls.length}`);
  log(`  Decision links found:  ${totalDecisionLinks}`);
  log(`  Actions inserted:      ${enforcementInserted}`);
  log(`  Skipped (resume):      ${enforcementSkipped}`);
  log(`  Errors:                ${enforcementErrors}`);

  // ----- Final summary -----
  if (db) {
    const provisionCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
    ).cnt;
    const sourcebookCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
    ).cnt;
    const enforcementCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
        cnt: number;
      }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
    ).cnt;

    log("");
    log("=== Database summary ===");
    log(`  Sourcebooks:         ${sourcebookCount}`);
    log(`  Provisions:          ${provisionCount}`);
    log(`  Enforcement actions: ${enforcementCount}`);
    log(`  FTS entries:         ${ftsCount}`);

    db.close();
  }

  // Clean up progress file on successful completion (not resume)
  if (!RESUME && existsSync(PROGRESS_FILE)) {
    unlinkSync(PROGRESS_FILE);
  }

  log("");
  log(DRY_RUN ? "Dry run complete. No data was written." : "Ingestion complete.");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFatal error: ${msg}`);
  process.exit(1);
});
