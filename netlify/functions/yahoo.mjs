// Proxy to Yahoo Finance's chart endpoint.
// Browsers cannot call Yahoo directly (CORS), so the terminal calls this
// function instead: GET /api/yahoo?symbol=SOXX&interval=1d&range=1y
// Yahoo's endpoint is unofficial and can change or rate-limit without notice.

const INTERVALS = new Set(["1m", "5m", "15m", "30m", "60m", "1d", "1wk"]);
const RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]);
const SYMBOL_RE = /^[A-Za-z0-9.=^-]{1,24}$/;

const json = (body, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });

export default async (req) => {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const interval = url.searchParams.get("interval") ?? "1d";
  const range = url.searchParams.get("range");
  const period1 = url.searchParams.get("period1");
  const period2 = url.searchParams.get("period2");

  if (!SYMBOL_RE.test(symbol)) return json({ error: "invalid symbol" }, 400);
  if (!INTERVALS.has(interval)) return json({ error: "invalid interval" }, 400);

  const params = new URLSearchParams({ interval, includePrePost: "false" });
  if (period1 && period2 && /^\d+$/.test(period1) && /^\d+$/.test(period2)) {
    params.set("period1", period1);
    params.set("period2", period2);
  } else if (range && RANGES.has(range)) {
    params.set("range", range);
  } else {
    params.set("range", "1y");
  }

  const upstream = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
    { headers: { "user-agent": "Mozilla/5.0 (compatible; OpenCharts)" } },
  );
  if (!upstream.ok) return json({ error: `yahoo ${upstream.status}` }, 502);

  // Short cache so scroll-back and polling do not hammer Yahoo.
  return json(await upstream.json(), 200, interval.endsWith("m") ? 10 : 60);
};

export const config = { path: "/api/yahoo" };
