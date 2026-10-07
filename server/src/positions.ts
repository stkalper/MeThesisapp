import type { Position, Side } from "./types.js";

/** Maintenance margin rate used for the liquidation estimate (Binance tier-1 is 0.4–0.5%). */
export const MAINTENANCE_MARGIN_RATE = 0.005;

export interface PositionMetrics {
  /** Quantity of the base asset */
  quantity: number;
  /** Capital the user actually put in (spot cost / perp margin) */
  invested: number;
  notional: number;
  value: number;
  pnl: number;
  /** PnL relative to invested capital (ROE for perps) */
  pnlPct: number;
  /** Raw price move from entry, signed in the position's favour */
  priceMovePct: number;
  liquidationPrice?: number;
  /** 0..1 — how close the mark is to liquidation (1 = liquidated) */
  liquidationProximity?: number;
  liquidated: boolean;
}

export function liquidationPrice(entry: number, leverage: number, side: Side, mmr = MAINTENANCE_MARGIN_RATE): number {
  // Isolated margin, linear USD-margined contract:
  // long  liquidates when loss = margin - maintenance → entry * (1 - 1/L + mmr)
  // short liquidates when loss = margin - maintenance → entry * (1 + 1/L - mmr)
  return side === "long" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export function computeMetrics(
  p: Pick<Position, "type" | "side" | "entryPrice" | "size" | "leverage">,
  markPrice: number,
): PositionMetrics {
  const direction = p.side === "long" ? 1 : -1;
  const priceMovePct = ((markPrice - p.entryPrice) / p.entryPrice) * 100 * direction;

  if (p.type === "spot") {
    const quantity = p.size;
    const invested = quantity * p.entryPrice;
    const pnl = (markPrice - p.entryPrice) * quantity * direction;
    return {
      quantity,
      invested,
      notional: invested,
      value: invested + pnl,
      pnl,
      pnlPct: invested ? (pnl / invested) * 100 : 0,
      priceMovePct,
      liquidated: false,
    };
  }

  const leverage = Math.max(1, p.leverage);
  const margin = p.size;
  const notional = margin * leverage;
  const quantity = notional / p.entryPrice;
  const liq = liquidationPrice(p.entryPrice, leverage, p.side);
  const liquidated = p.side === "long" ? markPrice <= liq : markPrice >= liq;
  // Once liquidated the loss is capped at the margin.
  const rawPnl = (markPrice - p.entryPrice) * quantity * direction;
  const pnl = liquidated ? -margin : rawPnl;
  const distanceToLiq = Math.abs(p.entryPrice - liq);
  const adverseMove = Math.max(0, (p.entryPrice - markPrice) * direction);

  return {
    quantity,
    invested: margin,
    notional,
    value: Math.max(0, margin + pnl),
    pnl,
    pnlPct: (pnl / margin) * 100,
    priceMovePct,
    liquidationPrice: liq,
    liquidationProximity: distanceToLiq ? Math.min(1, adverseMove / distanceToLiq) : 0,
    liquidated,
  };
}

/**
 * Has a pending limit order's price been reached? The order fills when the market crosses
 * the limit from the side it started on — a buy-the-dip limit below the market fills on the
 * way down, a breakout entry above the market fills on the way up.
 */
export function limitReached(p: Pick<Position, "entryPrice" | "refPrice">, markPrice: number): boolean {
  const ref = p.refPrice ?? markPrice;
  return ref >= p.entryPrice ? markPrice <= p.entryPrice : markPrice >= p.entryPrice;
}

/**
 * A perp whose mark price reached its liquidation level is closed there, like on an exchange:
 * returns the liquidation price to close at, or null if the position survives.
 * `alreadyLiquidated` keeps it closed even if the price has bounced back since the alert.
 */
export function liquidationExit(
  p: Pick<Position, "type" | "side" | "entryPrice" | "leverage" | "alertsSent">,
  markPrice: number,
): number | null {
  if (p.type !== "perp") return null;
  const liq = liquidationPrice(p.entryPrice, Math.max(1, p.leverage), p.side);
  const hit = p.side === "long" ? markPrice <= liq : markPrice >= liq;
  return hit || p.alertsSent.includes("liquidated") ? liq : null;
}

export type LevelEvent ="target" | "invalidation" | "liq-warning" | "liquidated";

/** Which thesis levels has the mark price crossed? */
export function crossedLevels(p: Position, markPrice: number): LevelEvent[] {
  const events: LevelEvent[] = [];
  const up = p.side === "long";
  const { targetPrice, invalidationPrice } = p.thesis;
  if (targetPrice && (up ? markPrice >= targetPrice : markPrice <= targetPrice)) events.push("target");
  if (invalidationPrice && (up ? markPrice <= invalidationPrice : markPrice >= invalidationPrice)) {
    events.push("invalidation");
  }
  if (p.type === "perp") {
    const m = computeMetrics(p, markPrice);
    if (m.liquidated) events.push("liquidated");
    else if ((m.liquidationProximity ?? 0) >= 0.7) events.push("liq-warning");
  }
  return events;
}
