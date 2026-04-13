import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const PORT = Number(process.env["PORT"]) || 8907;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";
const SCRAPER_URL = process.env["SCRAPER_URL"] || ""; // e.g. http://mcp-flights-scraper:8908

// ============================================================
// Flight Provider Interface
// ============================================================

interface FlightSearchParams {
  from: string;
  to: string;
  date: string;
  returnDate?: string;
  travelClass?: number; // 1=economy, 2=premium_economy, 3=business, 4=first
  adults?: number;
  maxStops?: number;
  currency?: string;
}

interface FlightLeg {
  departureAirport: string;
  departureTime: string;
  arrivalAirport: string;
  arrivalTime: string;
  airline: string;
  flightNumber: string;
  duration: number; // minutes
  aircraft?: string;
  travelClass?: string;
  legroom?: string;
}

interface FlightResult {
  legs: FlightLeg[];
  totalDuration: number; // minutes
  stops: number;
  price: number;
  currency: string;
  deepLink?: string;
  source: string;
}

interface FlightSearchResponse {
  results: FlightResult[];
  source: string;
  searchedAt: string;
  priceInsights?: {
    lowestPrice: number;
    priceLevel: string;
    typicalRange: [number, number];
  };
}

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
      env[trimmed.slice(0, eq)] = trimmed
        .slice(eq + 1)
        .replace(/^["']|["']$/g, "");
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

    const qs = new URLSearchParams({
      engine: "google_flights",
      api_key: creds.serpApiKey,
      departure_id: params.from.toUpperCase(),
      arrival_id: params.to.toUpperCase(),
      outbound_date: params.date,
      type: params.returnDate ? "1" : "2",
      adults: String(params.adults || 1),
      currency: params.currency || "EUR",
    });

    if (params.returnDate) qs.set("return_date", params.returnDate);
    if (params.travelClass) qs.set("travel_class", String(params.travelClass));
    if (params.maxStops !== undefined) qs.set("stops", String(params.maxStops));

    const resp = await fetch(`https://serpapi.com/search?${qs}`);
    if (!resp.ok) throw new Error(`SerpAPI HTTP ${resp.status}`);

    const data = await resp.json() as {
      search_metadata: { status: string };
      best_flights?: Array<{
        flights: Array<{
          departure_airport: { name: string; id: string; time: string };
          arrival_airport: { name: string; id: string; time: string };
          duration: number;
          airplane: string;
          airline: string;
          flight_number: string;
          travel_class: string;
          legroom: string;
        }>;
        total_duration: number;
        price: number;
      }>;
      other_flights?: Array<{
        flights: Array<{
          departure_airport: { name: string; id: string; time: string };
          arrival_airport: { name: string; id: string; time: string };
          duration: number;
          airplane: string;
          airline: string;
          flight_number: string;
          travel_class: string;
          legroom: string;
        }>;
        total_duration: number;
        price: number;
      }>;
      price_insights?: {
        lowest_price: number;
        price_level: string;
        typical_price_range: number[];
      };
      error?: string;
    };

    if (data.error) throw new Error(`SerpAPI: ${data.error}`);

    const allRaw = [...(data.best_flights || []), ...(data.other_flights || [])];
    const currency = params.currency || "EUR";

    const results: FlightResult[] = allRaw.map((f) => ({
      legs: f.flights.map((leg) => ({
        departureAirport: leg.departure_airport.id,
        departureTime: leg.departure_airport.time,
        arrivalAirport: leg.arrival_airport.id,
        arrivalTime: leg.arrival_airport.time,
        airline: leg.airline,
        flightNumber: leg.flight_number,
        duration: leg.duration,
        aircraft: leg.airplane,
        travelClass: leg.travel_class,
        legroom: leg.legroom,
      })),
      totalDuration: f.total_duration,
      stops: f.flights.length - 1,
      price: f.price,
      currency,
      source: "serpapi",
    }));

    const response: FlightSearchResponse = {
      results,
      source: "Google Flights via SerpAPI",
      searchedAt: new Date().toISOString(),
    };

    if (data.price_insights) {
      response.priceInsights = {
        lowestPrice: data.price_insights.lowest_price,
        priceLevel: data.price_insights.price_level,
        typicalRange: [
          data.price_insights.typical_price_range[0],
          data.price_insights.typical_price_range[1],
        ],
      };
    }

    return response;
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

  async search(params: FlightSearchParams): Promise<FlightSearchResponse> {
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
// Formatters
// ============================================================

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function travelClassToInt(cls: string): number {
  switch (cls.toLowerCase()) {
    case "economy": return 1;
    case "premium_economy": return 2;
    case "business": return 3;
    case "first": return 4;
    default: return 1;
  }
}

function travelClassLabel(n: number): string {
  switch (n) {
    case 1: return "Economy";
    case 2: return "Premium Economy";
    case 3: return "Business";
    case 4: return "First";
    default: return "Economy";
  }
}

function formatResults(data: FlightSearchResponse): string {
  const lines: string[] = [];
  lines.push(`## Flight Results (${data.source})\n`);

  if (data.priceInsights) {
    const pi = data.priceInsights;
    lines.push(
      `**Price insights:** ${pi.priceLevel} — typical range ${pi.typicalRange[0]}–${pi.typicalRange[1]} EUR, lowest ${pi.lowestPrice} EUR\n`,
    );
  }

  if (data.results.length === 0) {
    lines.push("No flights found for this route and date.\n");
    return lines.join("\n");
  }

  lines.push(
    "| # | Route | Airline | Duration | Stops | Class | Price | Legroom |",
  );
  lines.push(
    "|---|-------|---------|----------|-------|-------|-------|---------|",
  );

  for (let i = 0; i < Math.min(data.results.length, 15); i++) {
    const f = data.results[i];
    const first = f.legs[0];
    const last = f.legs[f.legs.length - 1];
    const route = `${first.departureAirport} → ${last.arrivalAirport}`;
    const airline = first.airline;
    const dur = formatDuration(f.totalDuration);
    const cls = first.travelClass || "Economy";
    const legroom = first.legroom || "—";
    const stopsLabel =
      f.stops === 0 ? "Direct" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`;
    lines.push(
      `| ${i + 1} | ${route} | ${airline} | ${dur} | ${stopsLabel} | ${cls} | ${f.price} ${f.currency} | ${legroom} |`,
    );
  }

  lines.push(
    `\n*${data.results.length} results total. Prices as of ${data.searchedAt} — may change.*`,
  );
  return lines.join("\n");
}

// ============================================================
// Tool: Search Flights
// ============================================================

async function searchFlights(params: {
  from: string;
  to: string;
  date: string;
  returnDate?: string;
  travelClass?: string;
  adults?: number;
  maxStops?: number;
  currency?: string;
  source?: string;
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
    returnDate: params.returnDate,
    travelClass,
    adults: params.adults,
    maxStops: params.maxStops,
    currency,
  };

  // Determine provider order
  const order: string[] =
    requestedSource === "auto"
      ? ["serpapi", "playwright"]
      : [requestedSource];

  let succeeded = false;

  for (const providerName of order) {
    const provider = getProvider(providerName);
    if (!provider) {
      results.push(`**${providerName}:** Unknown provider.\n`);
      continue;
    }
    if (!provider.available()) {
      if (requestedSource !== "auto") {
        results.push(`**${providerName}:** Not configured.\n`);
      }
      continue;
    }

    try {
      const data = await provider.search(searchParams);
      results.push(formatResults(data));
      succeeded = true;
      break; // Stop on first success
    } catch (e) {
      results.push(`**${providerName} error:** ${(e as Error).message}\n`);
    }
  }

  if (!succeeded) {
    results.push("No results from any source. Check dates and airport codes.\n");
    results.push(
      `**Manual check:** [Google Flights](https://www.google.com/travel/flights?q=flights+from+${params.from}+to+${params.to}+on+${params.date})`,
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
      const resp = await fetch(
        `https://serpapi.com/account?api_key=${creds.serpApiKey}`,
      );
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
    version: "0.2.0",
  });

  server.tool(
    "flights-search",
    "Search for flights between two airports. Returns prices, airlines, duration, stops, and cabin class. Primary source: Google Flights via SerpAPI. Fallback: Playwright browser scraper (when deployed).",
    {
      from: z
        .string()
        .min(2)
        .max(4)
        .describe("Departure airport IATA code (e.g., BCN, JFK, LHR)"),
      to: z
        .string()
        .min(2)
        .max(4)
        .describe("Arrival airport IATA code (e.g., NRT, CDG, LAX)"),
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
      currency: z
        .string()
        .optional()
        .default("EUR")
        .describe("Price currency (default: EUR)"),
      source: z
        .enum(["auto", "serpapi", "playwright"])
        .optional()
        .default("auto")
        .describe("Data source: auto (try providers in order), serpapi, or playwright"),
    },
    async (params) => ({
      content: [
        { type: "text" as const, text: await searchFlights(params) },
      ],
    }),
  );

  server.tool(
    "flights-api-usage",
    "Check flight API key status and remaining quota for all configured providers.",
    {},
    async () => ({
      content: [
        { type: "text" as const, text: await checkApiUsage() },
      ],
    }),
  );

  return server;
}

// ============================================================
// HTTP Server
// ============================================================

const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "mcp-flights",
          version: "0.2.0",
          providers: providers.map((p) => ({
            name: p.name,
            available: p.available(),
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/mcp") {
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`mcp-flights v0.2.0 listening on http://0.0.0.0:${PORT}/mcp`);
console.log(
  `Providers: ${providers.map((p) => `${p.name}=${p.available() ? "ready" : "not configured"}`).join(", ")}`,
);

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});
