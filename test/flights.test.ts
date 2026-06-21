import { describe, expect, test } from "bun:test";

import {
  buildSerpApiQuery,
  DEFAULT_PROVIDER_ORDER,
  type FlightSearchParams,
  type FlightSearchResponse,
  formatDuration,
  formatResults,
  googleFlightsManualUrl,
  MAX_RESULT_ROWS,
  parseSerpApiResponse,
  resolveProviderOrder,
  type SerpRawFlight,
  type SerpSearchData,
  TRAVEL_CLASS_LABELS,
  travelClassLabel,
  TRAVEL_CLASS_TO_INT,
  travelClassToInt,
} from "../src/flights.js";

// Expected values are derived BY HAND from the constants/branches in flights.ts,
// not by mirroring whatever the functions currently return, so a logic
// regression (wrong factor, dropped branch, etc.) is actually caught.

describe("formatDuration", () => {
  test("zero minutes", () => {
    // 0/60 = 0h, 0%60 = 0m → no minutes branch → "0h"
    expect(formatDuration(0)).toBe("0h");
  });

  test("exact hour drops the minutes segment", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(120)).toBe("2h");
  });

  test("hours and minutes", () => {
    // 95 = 1*60 + 35
    expect(formatDuration(95)).toBe("1h 35m");
  });

  test("sub-hour shows 0h plus minutes", () => {
    expect(formatDuration(45)).toBe("0h 45m");
  });

  test("large value", () => {
    // 1490 = 24*60 + 50
    expect(formatDuration(1490)).toBe("24h 50m");
  });
});

describe("travelClassToInt", () => {
  test("each known class maps to its documented int", () => {
    expect(travelClassToInt("economy")).toBe(1);
    expect(travelClassToInt("premium_economy")).toBe(2);
    expect(travelClassToInt("business")).toBe(3);
    expect(travelClassToInt("first")).toBe(4);
  });

  test("case-insensitive", () => {
    expect(travelClassToInt("Economy")).toBe(1);
    expect(travelClassToInt("BUSINESS")).toBe(3);
  });

  test("unknown defaults to economy (1)", () => {
    expect(travelClassToInt("yacht")).toBe(1);
    expect(travelClassToInt("")).toBe(1);
  });
});

describe("travelClassLabel", () => {
  test("each known int maps to its label", () => {
    expect(travelClassLabel(1)).toBe("Economy");
    expect(travelClassLabel(2)).toBe("Premium Economy");
    expect(travelClassLabel(3)).toBe("Business");
    expect(travelClassLabel(4)).toBe("First");
  });

  test("unknown defaults to Economy", () => {
    expect(travelClassLabel(0)).toBe("Economy");
    expect(travelClassLabel(99)).toBe("Economy");
  });

  test("int<->label tables are mutually consistent", () => {
    for (const [name, n] of Object.entries(TRAVEL_CLASS_TO_INT)) {
      // every code has a label, and the label table is keyed by that same code
      expect(TRAVEL_CLASS_LABELS[n]).toBeDefined();
      // round-trip the label back is not 1:1 (labels differ from names), but
      // the int produced from the canonical name must re-label without falling
      // through to the default for codes 1..4
      expect(travelClassToInt(name)).toBe(n);
    }
  });
});

describe("resolveProviderOrder", () => {
  test("auto expands to the default order", () => {
    expect(resolveProviderOrder("auto")).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(resolveProviderOrder("auto")).toEqual(["serpapi", "playwright"]);
  });

  test("explicit source becomes a single-element list", () => {
    expect(resolveProviderOrder("serpapi")).toEqual(["serpapi"]);
    expect(resolveProviderOrder("playwright")).toEqual(["playwright"]);
  });

  test("returns a fresh array (not a shared reference to the constant)", () => {
    const a = resolveProviderOrder("auto");
    a.push("mutated");
    expect(DEFAULT_PROVIDER_ORDER).toEqual(["serpapi", "playwright"]);
  });
});

describe("buildSerpApiQuery", () => {
  const base: FlightSearchParams = {
    from: "bcn",
    to: "nrt",
    date: "2026-07-01",
  };

  test("uppercases airport codes and sets fixed engine fields", () => {
    const qs = buildSerpApiQuery(base, "KEY123");
    expect(qs.get("engine")).toBe("google_flights");
    expect(qs.get("api_key")).toBe("KEY123");
    expect(qs.get("departure_id")).toBe("BCN");
    expect(qs.get("arrival_id")).toBe("NRT");
    expect(qs.get("outbound_date")).toBe("2026-07-01");
  });

  test("one-way uses type=2 and omits return_date", () => {
    const qs = buildSerpApiQuery(base, "K");
    expect(qs.get("type")).toBe("2");
    expect(qs.has("return_date")).toBe(false);
  });

  test("round trip uses type=1 and sets return_date", () => {
    const qs = buildSerpApiQuery({ ...base, returnDate: "2026-07-10" }, "K");
    expect(qs.get("type")).toBe("1");
    expect(qs.get("return_date")).toBe("2026-07-10");
  });

  test("adults defaults to 1 and currency to EUR", () => {
    const qs = buildSerpApiQuery(base, "K");
    expect(qs.get("adults")).toBe("1");
    expect(qs.get("currency")).toBe("EUR");
  });

  test("adults and currency are passed through when supplied", () => {
    const qs = buildSerpApiQuery({ ...base, adults: 3, currency: "USD" }, "K");
    expect(qs.get("adults")).toBe("3");
    expect(qs.get("currency")).toBe("USD");
  });

  test("travel_class is only set when truthy (0/undefined omitted)", () => {
    expect(buildSerpApiQuery(base, "K").has("travel_class")).toBe(false);
    expect(buildSerpApiQuery({ ...base, travelClass: 0 }, "K").has("travel_class")).toBe(false);
    expect(buildSerpApiQuery({ ...base, travelClass: 3 }, "K").get("travel_class")).toBe("3");
  });

  test("stops set for any defined value including 0", () => {
    expect(buildSerpApiQuery(base, "K").has("stops")).toBe(false);
    expect(buildSerpApiQuery({ ...base, maxStops: 0 }, "K").get("stops")).toBe("0");
    expect(buildSerpApiQuery({ ...base, maxStops: 2 }, "K").get("stops")).toBe("2");
  });
});

const rawFlight = (overrides: Partial<SerpRawFlight> = {}): SerpRawFlight => ({
  flights: [
    {
      departure_airport: { name: "Barcelona", id: "BCN", time: "2026-07-01 10:00" },
      arrival_airport: { name: "Tokyo", id: "NRT", time: "2026-07-02 06:00" },
      duration: 800,
      airplane: "Boeing 787",
      airline: "ANA",
      flight_number: "NH216",
      travel_class: "Economy",
      legroom: "31 in",
    },
  ],
  total_duration: 800,
  price: 750,
  ...overrides,
});

describe("parseSerpApiResponse", () => {
  test("throws on an API error payload", () => {
    expect(() => parseSerpApiResponse({ error: "bad key" }, "EUR")).toThrow("SerpAPI: bad key");
  });

  test("empty payload yields zero results", () => {
    const r = parseSerpApiResponse({}, "EUR");
    expect(r.results).toHaveLength(0);
    expect(r.source).toBe("Google Flights via SerpAPI");
    expect(r.priceInsights).toBeUndefined();
  });

  test("merges best_flights then other_flights in order", () => {
    const data: SerpSearchData = {
      best_flights: [rawFlight({ price: 100 })],
      other_flights: [rawFlight({ price: 200 })],
    };
    const r = parseSerpApiResponse(data, "EUR");
    expect(r.results.map((x) => x.price)).toEqual([100, 200]);
  });

  test("maps leg fields and stamps source=serpapi", () => {
    const r = parseSerpApiResponse({ best_flights: [rawFlight()] }, "USD");
    const result = r.results[0];
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.source).toBe("serpapi");
    expect(result.currency).toBe("USD");
    const leg = result.legs[0];
    expect(leg).toBeDefined();
    if (!leg) return;
    expect(leg.departureAirport).toBe("BCN");
    expect(leg.arrivalAirport).toBe("NRT");
    expect(leg.airline).toBe("ANA");
    expect(leg.flightNumber).toBe("NH216");
    expect(leg.aircraft).toBe("Boeing 787"); // airplane -> aircraft rename
  });

  test("stops = legs - 1 (direct vs one-stop)", () => {
    const direct = parseSerpApiResponse({ best_flights: [rawFlight()] }, "EUR");
    expect(direct.results[0]?.stops).toBe(0);

    const twoLeg = rawFlight();
    const firstLeg = twoLeg.flights[0];
    expect(firstLeg).toBeDefined();
    if (!firstLeg) return;
    twoLeg.flights = [firstLeg, firstLeg];
    const oneStop = parseSerpApiResponse({ best_flights: [twoLeg] }, "EUR");
    expect(oneStop.results[0]?.stops).toBe(1);
  });

  test("price insights are mapped (snake_case -> camelCase)", () => {
    const r = parseSerpApiResponse(
      {
        best_flights: [rawFlight()],
        price_insights: {
          lowest_price: 500,
          price_level: "low",
          typical_price_range: [450, 900],
        },
      },
      "EUR",
    );
    expect(r.priceInsights).toEqual({
      lowestPrice: 500,
      priceLevel: "low",
      typicalRange: [450, 900],
    });
  });
});

describe("formatResults", () => {
  const baseResponse = (results: FlightSearchResponse["results"]): FlightSearchResponse => ({
    results,
    source: "Google Flights via SerpAPI",
    searchedAt: "2026-06-21T00:00:00.000Z",
  });

  test("empty results renders the not-found line and no table", () => {
    const out = formatResults(baseResponse([]));
    expect(out).toContain("No flights found for this route and date.");
    expect(out).not.toContain("| # |");
  });

  test("renders a header, a row, and a totals footer", () => {
    const parsed = parseSerpApiResponse({ best_flights: [rawFlight()] }, "EUR");
    const out = formatResults(parsed);
    expect(out).toContain("## Flight Results (Google Flights via SerpAPI)");
    expect(out).toContain("| # | Route |");
    expect(out).toContain("BCN → NRT");
    expect(out).toContain("13h 20m"); // 800 min = 13h 20m
    expect(out).toContain("Direct");
    expect(out).toContain("750 EUR");
    expect(out).toContain("1 results total.");
  });

  test("multi-stop flights show a pluralized stop label", () => {
    const twoLeg = rawFlight();
    const firstLeg = twoLeg.flights[0];
    expect(firstLeg).toBeDefined();
    if (!firstLeg) return;
    twoLeg.flights = [firstLeg, firstLeg, firstLeg]; // 3 legs -> 2 stops
    const parsed = parseSerpApiResponse({ best_flights: [twoLeg] }, "EUR");
    expect(formatResults(parsed)).toContain("2 stops");
  });

  test("caps the table at MAX_RESULT_ROWS rows but reports the true total", () => {
    const many = Array.from({ length: MAX_RESULT_ROWS + 5 }, () => rawFlight());
    const parsed = parseSerpApiResponse({ best_flights: many }, "EUR");
    const out = formatResults(parsed);
    // data rows are lines that start with "| <n> |" — count them
    const dataRows = out.split("\n").filter((l) => /^\|\s\d+\s\|/.test(l)).length;
    expect(dataRows).toBe(MAX_RESULT_ROWS);
    expect(out).toContain(`${MAX_RESULT_ROWS + 5} results total.`);
  });

  test("price insights block is rendered when present", () => {
    const parsed = parseSerpApiResponse(
      {
        best_flights: [rawFlight()],
        price_insights: {
          lowest_price: 500,
          price_level: "low",
          typical_price_range: [450, 900],
        },
      },
      "EUR",
    );
    expect(formatResults(parsed)).toContain(
      "**Price insights:** low — typical range 450–900 EUR, lowest 500 EUR",
    );
  });
});

describe("googleFlightsManualUrl", () => {
  test("interpolates the route and date verbatim", () => {
    expect(googleFlightsManualUrl("BCN", "NRT", "2026-07-01")).toBe(
      "https://www.google.com/travel/flights?q=flights+from+BCN+to+NRT+on+2026-07-01",
    );
  });
});
