import { describe, expect, it } from "vitest";
import {
  buildUrl,
  createPortfolioMarketData,
  mergeBars,
  parseYahoo,
} from "../../examples/portfolio-adapter/portfolio-adapter.ts";

const payload = {
  chart: {
    result: [
      {
        meta: { regularMarketPrice: 101 },
        timestamp: [3600, 7200, 10800],
        indicators: {
          quote: [
            {
              open: [1, null, 3],
              high: [2, null, 4],
              low: [0.5, null, 2],
              close: [1.5, null, 3.5],
              volume: [10, null, 30],
            },
          ],
        },
      },
    ],
  },
};

describe("portfolio adapter", () => {
  it("parses Yahoo candles and skips null bars", () => {
    const bars = parseYahoo(payload);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ time: 3600, open: 1, close: 1.5, volume: 10 });
  });

  it("maps symbols to Yahoo tickers and timeframes", () => {
    expect(buildUrl({ symbol: "USDCOP", timeframe: "1d" })).toContain("symbol=COP%3DX");
    expect(buildUrl({ symbol: "SOXX", timeframe: "4h" })).toContain("interval=60m");
    expect(buildUrl({ symbol: "NOPE", timeframe: "1d" })).toBeNull();
  });

  it("uses period1/period2 when scrolling back", () => {
    const url = buildUrl({ symbol: "SOXX", timeframe: "1d", fromMs: 1000_000, toMs: 2000_000 })!;
    expect(url).toContain("period1=1000");
    expect(url).toContain("period2=2000");
  });

  it("merges hourly bars into 4h buckets", () => {
    const hour = (h: number, v: number) => ({
      time: h * 3600, open: v, high: v + 1, low: v - 1, close: v, volume: 1,
    });
    const merged = mergeBars([hour(0, 1), hour(1, 2), hour(3, 3), hour(4, 4)], 4);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ time: 0, open: 1, close: 3, high: 4, low: 0, volume: 3 });
  });

  it("returns candles through the market data source and emits ticks", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    const md = createPortfolioMarketData({ fetchImpl, pollMs: 1_000_000 });
    expect((await md.getSymbols()).some((s) => s.name === "SOXX")).toBe(true);
    expect(await md.getCandles({ symbol: "SOXX", timeframe: "1d" })).toHaveLength(2);
    const quote = await md.getQuote!("SOXX");
    expect(quote?.bid).toBe(101);
  });
});
