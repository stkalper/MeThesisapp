/** Parses user-typed numbers: accepts "0,5" (comma decimals), spaces and "$". NaN when invalid. */
export function parseNum(input: string): number {
  const s = input.trim().replace(/[\s$]/g, "").replace(",", ".");
  return s === "" ? NaN : Number(s);
}

export function usd(n: number | undefined, opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  const body = opts.compact && abs >= 10_000
    ? `${(abs / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`
    : abs.toLocaleString("en-US", { minimumFractionDigits: abs >= 1000 ? 0 : Math.min(2, digits), maximumFractionDigits: digits });
  const sign = n < 0 ? "-" : opts.sign ? "+" : "";
  return `${sign}$${body}`;
}

/** Price with sensible precision for any asset (BTC to memecoins). */
export function price(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 2 : n >= 1 ? 3 : n >= 0.01 ? 5 : 8;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

export const pct = (n: number | undefined, digits = 2) =>
  n === undefined || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

export function splitMoney(n: number): [string, string] {
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [int, dec] = s.split(".");
  return [`${n < 0 ? "-" : ""}$${int}`, `.${dec}`];
}

export function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const shortHash = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "");

/** Mirror of canonicalSize in server/src/journal.ts: spot → quantity, perp → margin. */
export function canonicalSize(
  type: "spot" | "perp",
  unit: "margin" | "usdt" | "token",
  value: number,
  entryPrice: number,
  leverage: number,
): number {
  if (!(value > 0 && entryPrice > 0)) return NaN;
  if (type === "spot") return unit === "token" ? value : value / entryPrice;
  if (unit === "margin") return value;
  const notional = unit === "token" ? value * entryPrice : value;
  return notional / leverage;
}

/** Trims insignificant digits off a coin quantity. */
export const qty = (n: number) =>
  n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });

/** Client-side mirror of server/src/positions.ts for the live simulator. */
export const MMR = 0.005;

export function simulate(
  p: { type: "spot" | "perp"; side: "long" | "short"; entryPrice: number; size: number; leverage: number },
  mark: number,
) {
  const dir = p.side === "long" ? 1 : -1;
  if (p.type === "spot") {
    const invested = p.size * p.entryPrice;
    const pnl = (mark - p.entryPrice) * p.size * dir;
    return { invested, pnl, pnlPct: invested ? (pnl / invested) * 100 : 0, liq: undefined as number | undefined, liquidated: false };
  }
  const lev = Math.max(1, p.leverage);
  const qty = (p.size * lev) / p.entryPrice;
  const liq = p.side === "long" ? p.entryPrice * (1 - 1 / lev + MMR) : p.entryPrice * (1 + 1 / lev - MMR);
  const liquidated = p.side === "long" ? mark <= liq : mark >= liq;
  const pnl = liquidated ? -p.size : (mark - p.entryPrice) * qty * dir;
  return { invested: p.size, pnl, pnlPct: (pnl / p.size) * 100, liq, liquidated };
}
