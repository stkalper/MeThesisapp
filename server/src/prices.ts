/**
 * Live spot prices. Primary source is Binance's public market-data mirror
 * (data-api.binance.vision works from regions where api.binance.com is blocked);
 * Coinbase is the fallback for anything Binance does not list.
 */

export interface Quote {
  symbol: string;
  price: number;
  change24hPct?: number;
  source: "binance" | "coinbase";
  at: number;
}

const CACHE_MS = 5_000;
const cache = new Map<string, Quote>();

export function normalizeSymbol(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[-_/]?(USDT|USDC|USD|PERP)$/u, "")
    .replace(/[^A-Z0-9]/gu, "");
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

async function fromBinance(symbols: string[]): Promise<Quote[]> {
  const pairs = JSON.stringify(symbols.map((s) => `${s}USDT`));
  const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(pairs)}`;
  const rows = await fetchJson<Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>>(url);
  return rows.map((r) => ({
    symbol: r.symbol.replace(/USDT$/u, ""),
    price: Number(r.lastPrice),
    change24hPct: Number(r.priceChangePercent),
    source: "binance" as const,
    at: Date.now(),
  }));
}

async function fromCoinbase(symbol: string): Promise<Quote> {
  const data = await fetchJson<{ data: { amount: string } }>(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`);
  return { symbol, price: Number(data.data.amount), source: "coinbase", at: Date.now() };
}

export async function getQuotes(input: string[]): Promise<Record<string, Quote>> {
  const symbols = [...new Set(input.map(normalizeSymbol).filter(Boolean))];
  const out: Record<string, Quote> = {};
  const stale: string[] = [];

  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && Date.now() - hit.at < CACHE_MS) out[s] = hit;
    else stale.push(s);
  }
  if (!stale.length) return out;

  // Binance rejects the whole batch if one symbol is unknown, so fall back per-symbol.
  let missing = stale;
  try {
    for (const q of await fromBinance(stale)) {
      cache.set(q.symbol, q);
      out[q.symbol] = q;
    }
    missing = [];
  } catch {
    const settled = await Promise.allSettled(stale.map((s) => fromBinance([s])));
    missing = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value[0]) {
        cache.set(r.value[0].symbol, r.value[0]);
        out[r.value[0].symbol] = r.value[0];
      } else missing.push(stale[i]!);
    });
  }

  await Promise.all(
    missing.map(async (s) => {
      try {
        const q = await fromCoinbase(s);
        cache.set(s, q);
        out[s] = q;
      } catch {
        const old = cache.get(s);
        if (old) out[s] = old; // serve stale rather than nothing
      }
    }),
  );
  return out;
}

export async function getPrice(symbol: string): Promise<number | undefined> {
  const s = normalizeSymbol(symbol);
  return (await getQuotes([s]))[s]?.price;
}
