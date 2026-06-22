// Pure, side-effect-free flight logic extracted from http.ts so it can be
// unit-tested without starting the HTTP server or hitting the network.
// Behavior here is IDENTICAL to the original inline implementations.

// ============================================================
// Types
// ============================================================

export interface FlightSearchParams {
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

export interface FlightSearchResponse {
  results: FlightResult[];
  source: string;
  searchedAt: string;
  priceInsights?: {
    lowestPrice: number;
    priceLevel: string;
    typicalRange: [number, number];
  };
}

// Shape of a single raw SerpAPI flight option (best_flights / other_flights).
export interface SerpRawFlight {
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
}

export interface SerpSearchData {
  search_metadata?: { status: string };
  best_flights?: SerpRawFlight[];
  other_flights?: SerpRawFlight[];
  price_insights?: {
    lowest_price: number;
    price_level: string;
    typical_price_range: number[];
  };
  error?: string;
}

// ============================================================
// Travel class mapping
// ============================================================

export const TRAVEL_CLASS_TO_INT: Record<string, number> = {
  economy: 1,
  premium_economy: 2,
  business: 3,
  first: 4,
};

export const TRAVEL_CLASS_LABELS: Record<number, string> = {
  1: "Economy",
  2: "Premium Economy",
  3: "Business",
  4: "First",
};

export function travelClassToInt(cls: string): number {
  return TRAVEL_CLASS_TO_INT[cls.toLowerCase()] ?? 1;
}

export function travelClassLabel(n: number): string {
  return TRAVEL_CLASS_LABELS[n] ?? "Economy";
}

// ============================================================
// Duration formatting
// ============================================================

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ============================================================
// Provider order resolution
// ============================================================

export const DEFAULT_PROVIDER_ORDER = ["serpapi", "playwright"] as const;

export function resolveProviderOrder(requestedSource: string): string[] {
  return requestedSource === "auto" ? [...DEFAULT_PROVIDER_ORDER] : [requestedSource];
}

// ============================================================
// SerpAPI query-string building (pure URL construction)
// ============================================================

export function buildSerpApiQuery(params: FlightSearchParams, apiKey: string): URLSearchParams {
  const qs = new URLSearchParams({
    engine: "google_flights",
    api_key: apiKey,
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

  return qs;
}

// ============================================================
// SerpAPI response normalization (pure transform)
// ============================================================

export function parseSerpApiResponse(data: SerpSearchData, currency: string): FlightSearchResponse {
  if (data.error) throw new Error(`SerpAPI: ${data.error}`);

  const allRaw = [...(data.best_flights || []), ...(data.other_flights || [])];

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
    const range = data.price_insights.typical_price_range;
    const low = range[0];
    const high = range[1];
    if (low !== undefined && high !== undefined) {
      response.priceInsights = {
        lowestPrice: data.price_insights.lowest_price,
        priceLevel: data.price_insights.price_level,
        typicalRange: [low, high],
      };
    }
  }

  return response;
}

// ============================================================
// Markdown results formatting
// ============================================================

export const MAX_RESULT_ROWS = 15;

// Format a single result as a Markdown table row, or null if the result has no
// usable legs (and should be skipped).
function formatResultRow(f: FlightResult, index: number): string | null {
  const first = f.legs[0];
  const last = f.legs[f.legs.length - 1];
  if (first === undefined || last === undefined) return null;
  const route = `${first.departureAirport} → ${last.arrivalAirport}`;
  const depart = first.departureTime || "—";
  const arrive = last.arrivalTime || "—";
  const airline = first.airline;
  const flightNo = first.flightNumber || "—";
  const dur = formatDuration(f.totalDuration);
  const cls = first.travelClass || "Economy";
  const legroom = first.legroom || "—";
  const stopsLabel = f.stops === 0 ? "Direct" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`;
  return `| ${index + 1} | ${route} | ${depart} | ${arrive} | ${airline} | ${flightNo} | ${dur} | ${stopsLabel} | ${cls} | ${f.price} ${f.currency} | ${legroom} |`;
}

export function formatResults(data: FlightSearchResponse): string {
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
    "| # | Route | Depart | Arrive | Airline | Flight | Duration | Stops | Class | Price | Legroom |",
  );
  lines.push(
    "|---|-------|--------|--------|---------|--------|----------|-------|-------|-------|---------|",
  );

  for (let i = 0; i < Math.min(data.results.length, MAX_RESULT_ROWS); i++) {
    const f = data.results[i];
    if (f === undefined) continue;
    const row = formatResultRow(f, i);
    if (row !== null) lines.push(row);
  }

  lines.push(
    `\n*${data.results.length} results total. Prices as of ${data.searchedAt} — may change.*`,
  );
  return lines.join("\n");
}

// ============================================================
// Google Flights manual-check fallback URL
// ============================================================

export function googleFlightsManualUrl(from: string, to: string, date: string): string {
  return `https://www.google.com/travel/flights?q=flights+from+${from}+to+${to}+on+${date}`;
}
