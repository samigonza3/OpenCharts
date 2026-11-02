import type {
  CandleRequest,
  ConnectionState,
  MarketDataSource,
  MarketEvent,
  OpenChartsAdapter,
  Quote,
  Unsubscribe,
} from "../../src/adapter/types.ts";
import type { Candle, Symbol } from "../../src/services/schemas.ts";

/**
 * Read-only chart adapter for a personal portfolio (stocks, ETFs, FX,
 * commodities, crypto) using Yahoo Finance through the Netlify function in
 * netlify/functions/yahoo.mjs.
 *
 * Edit PORTFOLIO below to change what shows up in the watchlist. `yahoo` is the
 * ticker as Yahoo writes it. Colombian stocks use the ".CL" suffix; confirm each
 * one at finance.yahoo.com before relying on it.
 *
 * Bitcoin streams live over Binance's websocket. Everything else comes from Yahoo,
 * refreshed every 5 seconds by polling, including pre-market and after-hours bars
 * on intraday charts. US stocks and ETFs are near real time; some other exchanges
 * (for example Colombia) are delayed by Yahoo. No trading: this is for charts.
 */

export interface PortfolioItem {
  yahoo: string;
  label: string;
  category: "STOCK" | "ETF" | "FX" | "COMMODITY" | "CRYPTO" | "COLOMBIA";
}

export const PORTFOLIO: Record<string, PortfolioItem> = {
  SOXX: { yahoo: "SOXX", label: "iShares Semiconductor ETF", category: "ETF" },
  META: { yahoo: "META", label: "Meta Platforms", category: "STOCK" },
  NFLX: { yahoo: "NFLX", label: "Netflix", category: "STOCK" },
  SHYG: { yahoo: "SHYG", label: "iShares 0-5 Year High Yield", category: "ETF" },
  SGOV: { yahoo: "SGOV", label: "iShares 0-3 Month Treasury", category: "ETF" },
  NU: { yahoo: "NU", label: "Nu Holdings", category: "STOCK" },
  PLTR: { yahoo: "PLTR", label: "Palantir", category: "STOCK" },
  AMD: { yahoo: "AMD", label: "AMD", category: "STOCK" },
  USDCOP: { yahoo: "COP=X", label: "USD/COP", category: "FX" },
  EURCOP: { yahoo: "EURCOP=X", label: "EUR/COP", category: "FX" },
  BRENT: { yahoo: "BZ=F", label: "Brent", category: "COMMODITY" },
  GOLD: { yahoo: "GC=F", label: "Oro", category: "COMMODITY" },
  ICHNA: { yahoo: "ICHNA.XD", label: "iShares MSCI China UCITS", category: "ETF" },
  ECOPETROL: { yahoo: "ECOPETROL.CL", label: "Ecopetrol", category: "COLOMBIA" },
  CELSIA: { yahoo: "CELSIA.CL", label: "Celsia", category: "COLOMBIA" },
  TERPEL: { yahoo: "TERPEL.CL", label: "Terpel", category: "COLOMBIA" },
};

const ENDPOINT = "/api/yahoo";
const POLL_MS = 5_000;
const MAX_POLLED = 10;

/** Symbols served live by Binance's websocket instead of Yahoo. */
export const BINANCE_SYMBOLS = ["BTCUSD"];

/** OpenCharts timeframe → Yahoo interval, default range, and bars to merge. */
const TF: Record<string, { interval: string; range: string; merge: number }> = {
  "1m": { interval: "1m", range: "5d", merge: 1 },
  "5m": { interval: "5m", range: "1mo", merge: 1 },
  "15m": { interval: "15m", range: "1mo", merge: 1 },
  "30m": { interval: "30m", range: "1mo", merge: 1 },
  "1h": { interval: "60m", range: "6mo", merge: 1 },
  "4h": { interval: "60m", range: "1y", merge: 4 },
  "1d": { interval: "1d", range: "5y", merge: 1 },
  "1w": { interval: "1wk", range: "max", merge: 1 },
};

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
  };
}

export function parseYahoo(payload: YahooChart): Candle[] {
  const result = payload.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !q) return [];
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i]!, open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
  }
  return out;
}

/** Merge consecutive bars into buckets of `n` (used for 4h from 1h). */
export function mergeBars(bars: Candle[], n: number): Candle[] {
  if (n <= 1) return bars;
  const bucketSec = n * 3600;
  const out: Candle[] = [];
  for (const b of bars) {
    const start = Math.floor(b.time / bucketSec) * bucketSec;
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ ...b, time: start });
    }
  }
  return out;
}

export function buildUrl(request: CandleRequest, base = ENDPOINT): string | null {
  const item = PORTFOLIO[request.symbol];
  const tf = TF[request.timeframe];
  if (!item || !tf) return null;
  const params = new URLSearchParams({ symbol: item.yahoo, interval: tf.interval });
  if (request.fromMs != null || request.toMs != null) {
    const to = request.toMs != null ? Math.floor(request.toMs / 1000) : Math.floor(Date.now() / 1000);
    const from = request.fromMs != null ? Math.floor(request.fromMs / 1000) : to - 60 * 86400;
    params.set("period1", String(from));
    params.set("period2", String(to));
  } else {
    params.set("range", tf.range);
  }
  return `${base}?${params.toString()}`;
}

function symbolSpec(name: string, item: PortfolioItem): Symbol {
  const tick = item.category === "FX" ? 0.0001 : 0.01;
  return {
    id: name,
    name,
    displayName: item.label,
    category: item.category,
    contractSize: 1,
    tickSize: tick,
    tickValue: tick,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
  } as Symbol;
}

export interface PortfolioOptions {
  symbols?: string[];
  fetchImpl?: typeof fetch;
  endpoint?: string;
  pollMs?: number;
}

export function createPortfolioMarketData(options: PortfolioOptions = {}): MarketDataSource {
  const names = options.symbols?.filter((s) => s in PORTFOLIO) ?? Object.keys(PORTFOLIO);
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const endpoint = options.endpoint ?? ENDPOINT;
  const pollMs = options.pollMs ?? POLL_MS;

  const handlers = new Set<(e: MarketEvent) => void>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = "disconnected";
  let timer: ReturnType<typeof setInterval> | null = null;
  let interest: string[] = [];

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const l of [...stateListeners]) l(next);
  };

  async function lastPrice(symbol: string): Promise<number | null> {
    const item = PORTFOLIO[symbol];
    if (!item) return null;
    // Last 1-minute bar of today, pre-market and after-hours included. Using the
    // last bar (not regularMarketPrice) keeps the price moving before the open.
    const params = new URLSearchParams({ symbol: item.yahoo, interval: "1m", range: "1d" });
    const res = await doFetch(`${endpoint}?${params.toString()}`);
    if (!res.ok) return null;
    const payload = (await res.json()) as YahooChart;
    const bars = parseYahoo(payload);
    if (bars.length) return bars[bars.length - 1]!.close;
    return payload.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  }

  async function poll() {
    const targets = (interest.length ? interest : names).slice(0, MAX_POLLED);
    let ok = false;
    await Promise.all(
      targets.map(async (symbol) => {
        try {
          const price = await lastPrice(symbol);
          if (price == null) return;
          ok = true;
          for (const h of [...handlers]) {
            h({ type: "tick", symbol, bid: price, ask: price, timestamp: Date.now() });
          }
        } catch {
          // One failed symbol should not stop the others.
        }
      }),
    );
    setState(ok ? "connected" : "reconnecting");
  }

  return {
    getSymbols: () => Promise.resolve(names.map((n) => symbolSpec(n, PORTFOLIO[n]!))),

    getCandles: async (request: CandleRequest): Promise<Candle[]> => {
      const url = buildUrl(request, endpoint);
      const tf = TF[request.timeframe];
      if (!url || !tf) return [];
      const res = await doFetch(url);
      if (!res.ok) return [];
      let bars = mergeBars(parseYahoo((await res.json()) as YahooChart), tf.merge);
      if (request.toMs != null) bars = bars.filter((b) => b.time * 1000 < request.toMs!);
      if (request.limit != null) bars = bars.slice(-request.limit);
      return bars;
    },

    getQuote: async (symbol: string): Promise<Quote | null> => {
      const price = await lastPrice(symbol).catch(() => null);
      return price == null ? null : { symbol, bid: price, ask: price, timestamp: Date.now() };
    },

    subscribe: (handler): Unsubscribe => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    connect: () => {
      if (timer) return;
      setState("connecting");
      void poll();
      timer = setInterval(() => void poll(), pollMs);
    },

    disconnect: () => {
      if (timer) clearInterval(timer);
      timer = null;
      setState("disconnected");
    },

    getConnectionState: () => state,

    onConnectionChange: (listener) => {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },

    setSymbolInterest: (symbols) => {
      interest = symbols.filter((s) => s in PORTFOLIO);
    },
  };
}

function combine(yahoo: MarketDataSource, binance: MarketDataSource): MarketDataSource {
  const isBinance = (symbol: string) => BINANCE_SYMBOLS.includes(symbol);
  const pick = (symbol: string) => (isBinance(symbol) ? binance : yahoo);
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const states: ConnectionState[] = ["disconnected", "disconnected"];
  const merged = (): ConnectionState =>
    states.includes("connected") ? "connected" : (states[0] ?? "disconnected");
  const notify = () => {
    for (const l of [...stateListeners]) l(merged());
  };
  yahoo.onConnectionChange?.((s) => {
    states[0] = s;
    notify();
  });
  binance.onConnectionChange?.((s) => {
    states[1] = s;
    notify();
  });

  return {
    getSymbols: async () => [...(await binance.getSymbols()), ...(await yahoo.getSymbols())],
    getCandles: (request) => pick(request.symbol).getCandles(request),
    getQuote: (symbol) => pick(symbol).getQuote?.(symbol) ?? Promise.resolve(null),
    subscribe: (handler) => {
      const offs = [yahoo.subscribe(handler), binance.subscribe(handler)];
      return () => offs.forEach((off) => off());
    },
    connect: () => {
      void yahoo.connect?.();
      void binance.connect?.();
    },
    disconnect: () => {
      yahoo.disconnect?.();
      binance.disconnect?.();
    },
    getConnectionState: merged,
    onConnectionChange: (listener) => {
      stateListeners.add(listener);
      listener(merged());
      return () => stateListeners.delete(listener);
    },
    setSymbolInterest: (symbols) => {
      yahoo.setSymbolInterest?.(symbols.filter((x) => !isBinance(x)));
    },
  };
}

/** Read-only: charts and watchlist only, no paper trading. */
export async function createPortfolioAdapter(
  options: PortfolioOptions = {},
): Promise<OpenChartsAdapter> {
  const [{ createDemoAdapter }, { createBinanceMarketData }] = await Promise.all([
    import("../../src/adapter/demo.ts"),
    import("../binance-adapter/binance-adapter.ts"),
  ]);
  return {
    name: "portfolio-yahoo-binance",
    marketData: combine(
      createPortfolioMarketData(options),
      createBinanceMarketData({ symbols: BINANCE_SYMBOLS }),
    ),
    storage: createDemoAdapter().storage,
  };
}
