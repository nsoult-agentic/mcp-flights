// Regression tests for the concurrency-crash bug: firing N parallel
// flights-search calls used to drop the whole MCP session. These assert the
// HTTP handler stays up and returns a proper Response for every request, even
// when the upstream provider hangs, throws, or returns garbage — a single bad
// request can never reject the handler or take down the process.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// The SerpAPI provider reads its key at first use; set it before importing the
// module so serpApiProvider.available() is true and requests reach the mock.
process.env["SERPAPI_API_KEY"] = "TEST_KEY";
process.env["SECRETS_DIR"] = "/nonexistent-for-tests";

const { handleRequest } = await import("../src/http.js");

const realFetch = globalThis.fetch;

// Minimal valid SerpAPI Google Flights payload.
const CANNED_SERP = {
  best_flights: [
    {
      flights: [
        {
          departure_airport: { name: "Barcelona", id: "BCN", time: "2026-11-03 10:00" },
          arrival_airport: { name: "Bangkok", id: "BKK", time: "2026-11-04 06:00" },
          duration: 800,
          airplane: "Boeing 787",
          airline: "Qatar Airways",
          flight_number: "QR146",
          travel_class: "Economy",
          legroom: "31 in",
        },
      ],
      total_duration: 800,
      price: 750,
    },
  ],
};

// Build a well-formed MCP tools/call POST for flights-search. Protocol-version
// header is omitted on purpose: the stateless transport accepts its absence and
// defaults, so no prior initialize handshake is needed per request.
function toolCallRequest(id: number, args: Record<string, unknown>): Request {
  return new Request("http://localhost:8907/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "flights-search", arguments: args },
    }),
  });
}

// The response is an SSE stream; extract the JSON-RPC result from its data line.
async function readMcpResult(res: Response): Promise<{
  result?: { content?: Array<{ text?: string }> };
  error?: unknown;
}> {
  const body = await res.text();
  const dataLine = body.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`no SSE data line in response body: ${body}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
}

function mockFetch(impl: (url: string) => Promise<Response>): void {
  globalThis.fetch = mock((input: string | URL | Request) =>
    impl(typeof input === "string" ? input : input.toString()),
  ) as unknown as typeof fetch;
}

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("concurrent flights-search requests", () => {
  beforeAll(() => {
    // Simulate real upstream latency so the requests genuinely overlap.
    mockFetch(
      (url) =>
        new Promise((resolve) => {
          setTimeout(
            () => {
              resolve(new Response(JSON.stringify(CANNED_SERP), { status: 200 }));
            },
            url.includes("serpapi") ? 20 : 0,
          );
        }),
    );
  });

  test("10 parallel searches all return a 200 result and the handler never rejects", async () => {
    const N = 10;
    const requests = Array.from({ length: N }, (_, i) =>
      handleRequest(toolCallRequest(i + 1, { from: "BCN", to: "BKK", date: "2026-11-03" })),
    );

    // Promise.all rejects if ANY handler call throws — that alone is the
    // regression guard (the old failure mode killed the request pipeline).
    const responses = await Promise.all(requests);

    expect(responses).toHaveLength(N);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const parsed = await readMcpResult(res);
      expect(parsed.error).toBeUndefined();
      const text = parsed.result?.content?.[0]?.text ?? "";
      expect(text).toContain("Flight Results");
      expect(text).toContain("BCN → BKK");
    }
  });
});

describe("handler is crash-proof against provider failures", () => {
  afterAll(() => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify(CANNED_SERP), { status: 200 })));
  });

  test("provider throwing (network error) yields a 200 with an error note, not a rejection", async () => {
    mockFetch(() => Promise.reject(new Error("boom: connection reset")));
    const res = await handleRequest(
      toolCallRequest(100, { from: "BCN", to: "BKK", date: "2026-11-03" }),
    );
    expect(res.status).toBe(200);
    const parsed = await readMcpResult(res);
    const text = parsed.result?.content?.[0]?.text ?? "";
    // tryProvider swallows the throw into a result line; falls through to the
    // no-results fallback rather than crashing.
    expect(text).toContain("serpapi error");
  });

  test("provider returning non-JSON is surfaced as an error, not a crash", async () => {
    mockFetch(() => Promise.resolve(new Response("<html>not json</html>", { status: 200 })));
    const res = await handleRequest(
      toolCallRequest(101, { from: "BCN", to: "BKK", date: "2026-11-03" }),
    );
    expect(res.status).toBe(200);
    const parsed = await readMcpResult(res);
    const text = parsed.result?.content?.[0]?.text ?? "";
    expect(text).toContain("malformed");
  });

  test("a mix of 8 failing and succeeding searches all resolve", async () => {
    let call = 0;
    mockFetch(() => {
      call += 1;
      if (call % 2 === 0) return Promise.reject(new Error("intermittent upstream failure"));
      return Promise.resolve(new Response(JSON.stringify(CANNED_SERP), { status: 200 }));
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        handleRequest(toolCallRequest(200 + i, { from: "BCN", to: "BKK", date: "2026-11-03" })),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });
});

describe("health endpoint", () => {
  test("reports ok and provider availability", async () => {
    const res = await handleRequest(new Request("http://localhost:8907/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      providers: Array<{ name: string; available: boolean }>;
    };
    expect(body.status).toBe("ok");
    const serp = body.providers.find((p) => p.name === "serpapi");
    expect(serp?.available).toBe(true);
  });
});
