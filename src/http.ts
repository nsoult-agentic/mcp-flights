import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const PORT = Number(process.env["PORT"]) || 8907;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";

// --- Credential Loading ---

interface Credentials {
  serpApiKey: string;
  kiwiApiKey: string;
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
    kiwiApiKey: env["KIWI_API_KEY"] || process.env["KIWI_API_KEY"] || "",
  };
}

let _creds: Credentials | undefined;
function getCreds(): Credentials {
  if (!_creds) _creds = loadCredentials();
  return _creds;
}

// --- SerpAPI Client ---

interface SerpApiFlight {
  departure_airport: { name: string; id: string; time: string };
  arrival_airport: { name: string; id: string; time: string };
  duration: number;
  airplane: string;
  airline: string;
  flight_number: string;
  travel_class: string;
  legroom: string;
  extensions: string[];
}

interface SerpApiResult {
  flights: SerpApiFlight[];
  total_duration: number;
  price: number;
  type: string;
  carbon_emissions?: { this_flight: number; typical_for_route: number };
}

interface SerpApiResponse {
  search_metadata: { status: string };
  best_flights?: SerpApiResult[];
  other_flights?: SerpApiResult[];
  price_insights?: {
    lowest_price: number;
    price_level: string;
    typical_price_range: number[];
  };
  error?: string;
}

async function searchSerpApi(params: {
  from: string;
  to: string;
  date: string;
  returnDate?: string;
  travelClass?: number;
  adults?: number;
  stops?: number;
  currency?: string;
}): Promise<SerpApiResponse> {
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
  if (params.stops !== undefined) qs.set("stops", String(params.stops));

  const resp = await fetch(`https://serpapi.com/search?${qs}`);
  if (!resp.ok) throw new Error(`SerpAPI error: ${resp.status}`);
  return resp.json() as Promise<SerpApiResponse>;
}

// --- Kiwi Tequila Client ---

interface KiwiRoute {
  local_departure: string;
  local_arrival: string;
  flyFrom: string;
  flyTo: string;
  cityFrom: string;
  cityTo: string;
  airline: string;
  flight_no: number;
  equipment: string;
}

interface KiwiResult {
  id: string;
  price: number;
  route: KiwiRoute[];
  deep_link: string;
  availability: { seats: number };
}

interface KiwiResponse {
  data: KiwiResult[];
  currency: string;
  search_params: Record<string, string>;
}

async function searchKiwi(params: {
  from: string;
  to: string;
  dateFrom: string;
  dateTo: string;
  returnFrom?: string;
  returnTo?: string;
  adults?: number;
  currency?: string;
  maxStopovers?: number;
}): Promise<KiwiResponse> {
  const creds = getCreds();
  if (!creds.kiwiApiKey) throw new Error("KIWI_API_KEY not configured");

  const qs = new URLSearchParams({
    fly_from: params.from.toUpperCase(),
    fly_to: params.to.toUpperCase(),
    date_from: params.dateFrom,
    date_to: params.dateTo,
    curr: params.currency || "EUR",
    adults: String(params.adults || 1),
    flight_type: params.returnFrom ? "round" : "oneway",
    limit: "10",
    sort: "price",
  });

  if (params.returnFrom) qs.set("return_from", params.returnFrom);
  if (params.returnTo) qs.set("return_to", params.returnTo);
  if (params.maxStopovers !== undefined)
    qs.set("max_stopovers", String(params.maxStopovers));

  const resp = await fetch(
    `https://tequila-api.kiwi.com/v2/search?${qs}`,
    { headers: { apikey: creds.kiwiApiKey } },
  );
  if (!resp.ok) throw new Error(`Kiwi API error: ${resp.status}`);
  return resp.json() as Promise<KiwiResponse>;
}

// --- Formatters ---

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

function formatSerpApiResults(data: SerpApiResponse, source: string): string {
  const lines: string[] = [];
  lines.push(`## Flight Results (${source})\n`);

  if (data.price_insights) {
    const pi = data.price_insights;
    lines.push(
      `**Price insights:** ${pi.price_level} — typical range ${pi.typical_price_range[0]}–${pi.typical_price_range[1]} EUR, lowest ${pi.lowest_price} EUR\n`,
    );
  }

  const allFlights = [
    ...(data.best_flights || []).map((f) => ({ ...f, _tier: "Best" })),
    ...(data.other_flights || []).map((f) => ({ ...f, _tier: "Other" })),
  ];

  if (allFlights.length === 0) {
    lines.push("No flights found for this route and date.\n");
    return lines.join("\n");
  }

  lines.push(
    "| # | Route | Airline | Duration | Stops | Class | Price | Legroom |",
  );
  lines.push(
    "|---|-------|---------|----------|-------|-------|-------|---------|",
  );

  for (let i = 0; i < Math.min(allFlights.length, 15); i++) {
    const f = allFlights[i];
    const legs = f.flights;
    const first = legs[0];
    const last = legs[legs.length - 1];
    const stops = legs.length - 1;
    const route = `${first.departure_airport.id} → ${last.arrival_airport.id}`;
    const airline = first.airline;
    const dur = formatDuration(f.total_duration);
    const cls = first.travel_class || "Economy";
    const legroom = first.legroom || "—";
    lines.push(
      `| ${i + 1} | ${route} | ${airline} | ${dur} | ${stops === 0 ? "Direct" : stops + " stop" + (stops > 1 ? "s" : "")} | ${cls} | ${f.price} EUR | ${legroom} |`,
    );
  }

  lines.push(`\n*${allFlights.length} results total. Prices as of search time — may change.*`);
  return lines.join("\n");
}

function formatKiwiResults(data: KiwiResponse): string {
  const lines: string[] = [];
  lines.push("## Flight Results (Kiwi)\n");

  if (!data.data || data.data.length === 0) {
    lines.push("No flights found for this route and date range.\n");
    return lines.join("\n");
  }

  lines.push("| # | Route | Airlines | Stops | Price | Book |");
  lines.push("|---|-------|----------|-------|-------|------|");

  for (let i = 0; i < Math.min(data.data.length, 10); i++) {
    const f = data.data[i];
    const r = f.route;
    const first = r[0];
    const last = r[r.length - 1];
    const route = `${first.flyFrom} → ${last.flyTo}`;
    const airlines = [...new Set(r.map((s) => s.airline))].join(", ");
    const stops = r.length - 1;
    const link = `[Book](${f.deep_link})`;
    lines.push(
      `| ${i + 1} | ${route} | ${airlines} | ${stops === 0 ? "Direct" : stops + " stop" + (stops > 1 ? "s" : "")} | ${f.price} ${data.currency} | ${link} |`,
    );
  }

  lines.push(`\n*${data.data.length} results total. Prices as of search time — may change.*`);
  return lines.join("\n");
}

// --- Tool: Search Flights ---

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
  const source = params.source || "serpapi";
  const results: string[] = [];
  const timestamp = new Date().toISOString();

  results.push(`*Search: ${params.from.toUpperCase()} → ${params.to.toUpperCase()} on ${params.date}${params.returnDate ? ` (return ${params.returnDate})` : ""} | ${travelClassLabel(travelClassToInt(params.travelClass || "economy"))} | ${timestamp}*\n`);

  if (source === "serpapi" || source === "both") {
    try {
      const serpData = await searchSerpApi({
        from: params.from,
        to: params.to,
        date: params.date,
        returnDate: params.returnDate,
        travelClass: travelClassToInt(params.travelClass || "economy"),
        adults: params.adults,
        stops: params.maxStops,
        currency,
      });
      if (serpData.error) {
        results.push(`**SerpAPI error:** ${serpData.error}\n`);
      } else {
        results.push(formatSerpApiResults(serpData, "Google Flights via SerpAPI"));
      }
    } catch (e) {
      results.push(`**SerpAPI unavailable:** ${(e as Error).message}\n`);
    }
  }

  if (source === "kiwi" || source === "both") {
    try {
      // Kiwi uses dd/mm/YYYY format
      const [y, m, d] = params.date.split("-");
      const dateFrom = `${d}/${m}/${y}`;
      let returnFrom: string | undefined;
      let returnTo: string | undefined;
      if (params.returnDate) {
        const [ry, rm, rd] = params.returnDate.split("-");
        returnFrom = `${rd}/${rm}/${ry}`;
        returnTo = returnFrom;
      }
      const kiwiData = await searchKiwi({
        from: params.from,
        to: params.to,
        dateFrom,
        dateTo: dateFrom,
        returnFrom,
        returnTo,
        adults: params.adults,
        currency,
        maxStopovers: params.maxStops,
      });
      results.push(formatKiwiResults(kiwiData));
    } catch (e) {
      results.push(`**Kiwi unavailable:** ${(e as Error).message}\n`);
    }
  }

  if (results.length <= 1) {
    results.push("No results from any source. Check dates and airport codes.\n");
    results.push(`**Manual check:** [Google Flights](https://www.google.com/travel/flights?q=flights+from+${params.from}+to+${params.to}+on+${params.date})`);
  }

  return results.join("\n");
}

// --- Tool: API Usage ---

async function checkApiUsage(): Promise<string> {
  const creds = getCreds();
  const lines: string[] = ["## Flight API Status\n"];

  lines.push("| API | Status | Free Tier |");
  lines.push("|-----|--------|-----------|");

  // SerpAPI
  if (creds.serpApiKey) {
    try {
      const resp = await fetch(
        `https://serpapi.com/account?api_key=${creds.serpApiKey}`,
      );
      if (resp.ok) {
        const data = (await resp.json()) as {
          total_searches_left: number;
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

  // Kiwi
  if (creds.kiwiApiKey) {
    lines.push("| Kiwi Tequila | Key configured | Free (affiliate model) |");
  } else {
    lines.push("| Kiwi Tequila | **NOT CONFIGURED** | Free (affiliate model) |");
  }

  return lines.join("\n");
}

// --- MCP Server ---

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-flights",
    version: "0.1.0",
  });

  server.tool(
    "flights-search",
    "Search for flights between two airports. Returns prices, airlines, duration, stops, and booking links. Uses Google Flights (via SerpAPI) as primary source and Kiwi as fallback.",
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
      date: z
        .string()
        .describe("Departure date in YYYY-MM-DD format"),
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
        .enum(["serpapi", "kiwi", "both"])
        .optional()
        .default("serpapi")
        .describe("Data source: serpapi (Google Flights), kiwi, or both"),
    },
    async (params) => ({
      content: [
        { type: "text" as const, text: await searchFlights(params) },
      ],
    }),
  );

  server.tool(
    "flights-api-usage",
    "Check flight API key status and remaining quota.",
    {},
    async () => ({
      content: [
        { type: "text" as const, text: await checkApiUsage() },
      ],
    }),
  );

  return server;
}

// --- HTTP Server ---

const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "mcp-flights", version: "0.1.0" }),
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

console.log(`mcp-flights listening on http://0.0.0.0:${PORT}/mcp`);

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});
