import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  buildSerpApiQuery,
  type FlightSearchParams,
  type FlightSearchResponse,
  formatResults,
  googleFlightsManualUrl,
  parseSerpApiResponse,
  resolveProviderOrder,
  type SerpSearchData,
  travelClassLabel,
  travelClassToInt,
} from "./flights.js";

const PORT = Number(process.env["PORT"]) || 8907;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";
const SCRAPER_URL = process.env["SCRAPER_URL"] || ""; // e.g. http://mcp-flights-scraper:8908
// Bound every upstream call so a slow/stuck provider under concurrent load can
// never leave an MCP request hanging (which the client reports as "Connection
// closed" and then tears down the whole session).
const FETCH_TIMEOUT_MS = Number(process.env["FETCH_TIMEOUT_MS"]) || 25_000;

// ============================================================
// Flight Provider Interface
// ============================================================

interface FlightProvider {
  name: string;
  available(): boolean;
  search(params: FlightSearchParams): Promise<FlightSearchResponse>;
}

// ============================================================
// Credential Loading
// ============================================================

interface Credentials {
  serpApiKey: string;
}

function loadCredentials(): Credentials {
  const envPath = resolve(SECRETS_DIR, "flights.env");
  const env: Record<string, string> = {};

  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
  }

  return {
    serpApiKey: env["SERPAPI_API_KEY"] || process.env["SERPAPI_API_KEY"] || "",
  };
}

let _creds: Credentials | undefined;
function getCreds(): Credentials {
  if (!_creds) _creds = loadCredentials();
  return _creds;
}

// ============================================================
// Provider: SerpAPI (Google Flights)
// ============================================================

const serpApiProvider: FlightProvider = {
  name: "serpapi",

  available(): boolean {
    return !!getCreds().serpApiKey;
  },

  async search(params: FlightSearchParams): Promise<FlightSearchResponse> {
    const creds = getCreds();
    if (!creds.serpApiKey) throw new Error("SERPAPI_API_KEY not configured");

    const qs = buildSerpApiQuery(params, creds.serpApiKey);

    let resp: Response;
    try {
      resp = await fetch(`https://serpapi.com/search?${qs}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") {
        throw new Error(`SerpAPI request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw new Error(`SerpAPI request failed: ${(e as Error).message}`);
    }
    if (!resp.ok) throw new Error(`SerpAPI HTTP ${resp.status}`);

    let data: SerpSearchData;
    try {
      data = (await resp.json()) as SerpSearchData;
    } catch {
      throw new Error("SerpAPI returned a malformed (non-JSON) response");
    }
    const currency = params.currency || "EUR";

    return parseSerpApiResponse(data, currency);
  },
};

// ============================================================
// Provider: Playwright Scraper (stub — separate container)
// ============================================================

const playwrightProvider: FlightProvider = {
  name: "playwright",

  available(): boolean {
    return !!SCRAPER_URL;
  },

  async search(_params: FlightSearchParams): Promise<FlightSearchResponse> {
    if (!SCRAPER_URL) {
      throw new Error(
        "Playwright scraper not configured. Set SCRAPER_URL env var to the mcp-flights-scraper endpoint.",
      );
    }

    // Future: POST to mcp-flights-scraper service
    // const resp = await fetch(`${SCRAPER_URL}/scrape/flights`, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify(params),
    // });
    // return resp.json() as Promise<FlightSearchResponse>;

    throw new Error(
      "Playwright scraper not yet implemented. Will be built as a separate container (mcp-flights-scraper) when needed.",
    );
  },
};

// ============================================================
// Provider Registry
// ============================================================

const providers: FlightProvider[] = [serpApiProvider, playwrightProvider];

function getProvider(name: string): FlightProvider | undefined {
  return providers.find((p) => p.name === name);
}

// ============================================================
// Tool: Search Flights
// ============================================================

// Try a single provider; pushes its status/results into `results` and returns
// true only if it produced flight results (i.e. the loop should stop).
async function tryProvider(
  providerName: string,
  requestedSource: string,
  searchParams: FlightSearchParams,
  results: string[],
): Promise<boolean> {
  const provider = getProvider(providerName);
  if (!provider) {
    results.push(`**${providerName}:** Unknown provider.\n`);
    return false;
  }
  if (!provider.available()) {
    if (requestedSource !== "auto") {
      results.push(`**${providerName}:** Not configured.\n`);
    }
    return false;
  }

  try {
    const data = await provider.search(searchParams);
    results.push(formatResults(data));
    return true;
  } catch (e) {
    results.push(`**${providerName} error:** ${(e as Error).message}\n`);
    return false;
  }
}

// Run providers in order, stopping on the first success.
async function runProviders(
  order: string[],
  requestedSource: string,
  searchParams: FlightSearchParams,
  results: string[],
): Promise<boolean> {
  for (const providerName of order) {
    if (await tryProvider(providerName, requestedSource, searchParams, results)) {
      return true;
    }
  }
  return false;
}

async function searchFlights(params: {
  from: string;
  to: string;
  date: string;
  // I/O boundary: these come from Zod `.optional()` shapes, which produce `T | undefined`.
  returnDate?: string | undefined;
  travelClass?: string | undefined;
  adults?: number | undefined;
  maxStops?: number | undefined;
  currency?: string | undefined;
  source?: string | undefined;
}): Promise<string> {
  const currency = params.currency || "EUR";
  const requestedSource = params.source || "auto";
  const travelClass = travelClassToInt(params.travelClass || "economy");
  const results: string[] = [];

  results.push(
    `*Search: ${params.from.toUpperCase()} → ${params.to.toUpperCase()} on ${params.date}${params.returnDate ? ` (return ${params.returnDate})` : ""} | ${travelClassLabel(travelClass)} | ${new Date().toISOString()}*\n`,
  );

  const searchParams: FlightSearchParams = {
    from: params.from,
    to: params.to,
    date: params.date,
    travelClass,
    currency,
    ...(params.returnDate !== undefined ? { returnDate: params.returnDate } : {}),
    ...(params.adults !== undefined ? { adults: params.adults } : {}),
    ...(params.maxStops !== undefined ? { maxStops: params.maxStops } : {}),
  };

  // Determine provider order
  const order: string[] = resolveProviderOrder(requestedSource);

  const succeeded = await runProviders(order, requestedSource, searchParams, results);

  if (!succeeded) {
    results.push("No results from any source. Check dates and airport codes.\n");
    results.push(
      `**Manual check:** [Google Flights](${googleFlightsManualUrl(params.from, params.to, params.date)})`,
    );
  }

  return results.join("\n");
}

// ============================================================
// Tool: API Usage
// ============================================================

async function checkApiUsage(): Promise<string> {
  const creds = getCreds();
  const lines: string[] = ["## Flight API Status\n"];

  lines.push("| Provider | Status | Free Tier |");
  lines.push("|----------|--------|-----------|");

  // SerpAPI
  if (creds.serpApiKey) {
    try {
      const resp = await fetch(`https://serpapi.com/account?api_key=${creds.serpApiKey}`);
      if (resp.ok) {
        const data = (await resp.json()) as {
          plan_searches_left: number;
          plan_name: string;
        };
        lines.push(
          `| SerpAPI | ${data.plan_searches_left} searches remaining (${data.plan_name}) | 250/month |`,
        );
      } else {
        lines.push("| SerpAPI | Key configured, status check failed | 250/month |");
      }
    } catch {
      lines.push("| SerpAPI | Key configured, unreachable | 250/month |");
    }
  } else {
    lines.push("| SerpAPI | **NOT CONFIGURED** | 250/month |");
  }

  // Playwright scraper
  if (SCRAPER_URL) {
    try {
      const resp = await fetch(`${SCRAPER_URL}/health`);
      if (resp.ok) {
        lines.push("| Playwright Scraper | Online | Free (self-hosted) |");
      } else {
        lines.push("| Playwright Scraper | Unhealthy | Free (self-hosted) |");
      }
    } catch {
      lines.push("| Playwright Scraper | Unreachable | Free (self-hosted) |");
    }
  } else {
    lines.push("| Playwright Scraper | Not deployed | Free (self-hosted) |");
  }

  return lines.join("\n");
}

// ============================================================
// MCP Server
// ============================================================

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-flights",
    version: "0.3.0",
  });

  server.tool(
    "flights-search",
    "Search for flights between two airports. Returns prices, airlines, duration, stops, and cabin class. Primary source: Google Flights via SerpAPI. Fallback: Playwright browser scraper (when deployed).",
    {
      from: z.string().min(2).max(4).describe("Departure airport IATA code (e.g., BCN, JFK, LHR)"),
      to: z.string().min(2).max(4).describe("Arrival airport IATA code (e.g., NRT, CDG, LAX)"),
      date: z.string().describe("Departure date in YYYY-MM-DD format"),
      returnDate: z
        .string()
        .optional()
        .describe("Return date in YYYY-MM-DD format (omit for one-way)"),
      travelClass: z
        .enum(["economy", "premium_economy", "business", "first"])
        .optional()
        .default("economy")
        .describe("Cabin class"),
      adults: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .default(1)
        .describe("Number of adult passengers"),
      maxStops: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe("Maximum number of stops (0 = direct only)"),
      currency: z.string().optional().default("EUR").describe("Price currency (default: EUR)"),
      source: z
        .enum(["auto", "serpapi", "playwright"])
        .optional()
        .default("auto")
        .describe("Data source: auto (try providers in order), serpapi, or playwright"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: await searchFlights(params) }],
    }),
  );

  server.tool(
    "flights-api-usage",
    "Check flight API key status and remaining quota for all configured providers.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await checkApiUsage() }],
    }),
  );

  return server;
}

// ============================================================
// HTTP Server
// ============================================================

const VERSION = "0.3.0";

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Handle a single MCP request. The stateless pattern requires a FRESH server +
// transport per request (the SDK throws if a stateless transport is reused), so
// there is no cross-request shared state. Any failure here is contained: it
// returns a JSON-RPC error instead of rejecting, so one bad request can never
// take down the process or drop the whole MCP session.
async function handleMcpRequest(req: Request): Promise<Response> {
  const server = createServer();
  // Stateless mode: omitting sessionIdGenerator leaves it undefined (no sessions).
  const transport = new WebStandardStreamableHTTPServerTransport({});
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    console.error("[mcp] request handling failed:", err);
    // Best-effort teardown so a failed request leaks nothing.
    try {
      await transport.close();
    } catch {
      /* already closed */
    }
    try {
      await server.close();
    } catch {
      /* already closed */
    }
    return jsonRpcErrorResponse(500, -32603, "Internal server error");
  }
}

// Exported for tests: the full HTTP router. Never rejects.
export async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "mcp-flights",
          version: VERSION,
          providers: providers.map((p) => ({
            name: p.name,
            available: p.available(),
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/mcp") {
      return await handleMcpRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  } catch (err) {
    console.error("[http] unexpected router error:", err);
    return jsonRpcErrorResponse(500, -32603, "Internal server error");
  }
}

// Crash-proofing: a stray async error (e.g. from the fire-and-forget tool
// pipeline that runs after the HTTP response is returned) must never terminate
// the process. Log it and keep serving. This is what turns a one-request
// failure into a survivable event instead of a full server drop.
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
}

// Only bind the port / install guards when run as the entrypoint, so tests can
// import handleRequest without starting a real server.
if (import.meta.main) {
  installProcessGuards();

  const httpServer = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    fetch: handleRequest,
  });

  console.log(`mcp-flights v${VERSION} listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(
    `Providers: ${providers.map((p) => `${p.name}=${p.available() ? "ready" : "not configured"}`).join(", ")}`,
  );

  process.on("SIGTERM", () => {
    httpServer.stop();
    process.exit(0);
  });
}
