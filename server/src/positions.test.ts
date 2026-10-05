import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, crossedLevels, limitReached, liquidationPrice } from "./positions.js";
import { canonicalSize } from "./journal.js";

test("limit orders fill when price crosses from the starting side", () => {
  // buy the dip: limit below market
  assert.equal(limitReached({ entryPrice: 90, refPrice: 100 }, 95), false);
  assert.equal(limitReached({ entryPrice: 90, refPrice: 100 }, 89.9), true);
  // breakout entry: limit above market
  assert.equal(limitReached({ entryPrice: 110, refPrice: 100 }, 105), false);
  assert.equal(limitReached({ entryPrice: 110, refPrice: 100 }, 110), true);
});

test("size units convert to canonical size", () => {
  close(canonicalSize("spot", "usdt", 500, 100, 1), 5); // $500 buys 5 coins
  close(canonicalSize("spot", "token", 2, 100, 1), 2);
  close(canonicalSize("perp", "margin", 200, 100, 10), 200);
  close(canonicalSize("perp", "usdt", 2000, 100, 10), 200); // $2000 position at 10x = $200 margin
  close(canonicalSize("perp", "token", 20, 100, 10), 200); // 20 coins * $100 / 10x
});
import type { Position } from "./types.js";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("spot long PnL", () => {
  const m = computeMetrics({ type: "spot", side: "long", entryPrice: 100, size: 2, leverage: 1 }, 150);
  close(m.invested, 200);
  close(m.pnl, 100);
  close(m.pnlPct, 50);
  close(m.value, 300);
  assert.equal(m.liquidationPrice, undefined);
});

test("perp long 10x: PnL, ROE and liquidation", () => {
  const p = { type: "perp" as const, side: "long" as const, entryPrice: 100, size: 100, leverage: 10 };
  const m = computeMetrics(p, 105);
  close(m.notional, 1000);
  close(m.quantity, 10);
  close(m.pnl, 50);
  close(m.pnlPct, 50); // 5% move * 10x
  close(m.liquidationPrice!, 90.5);
  assert.equal(m.liquidated, false);
});

test("perp short liquidation price and capped loss", () => {
  close(liquidationPrice(100, 5, "short"), 119.5);
  const m = computeMetrics({ type: "perp", side: "short", entryPrice: 100, size: 50, leverage: 5 }, 130);
  assert.equal(m.liquidated, true);
  close(m.pnl, -50);
  close(m.value, 0);
});

test("perp short profits when price falls", () => {
  const m = computeMetrics({ type: "perp", side: "short", entryPrice: 200, size: 100, leverage: 3 }, 180);
  close(m.pnl, 30); // 300 notional, 1.5 qty, $20 move
  close(m.priceMovePct, 10);
});

test("crossed levels respect side", () => {
  const base: Position = {
    id: "1",
    userId: "u",
    type: "perp",
    symbol: "BTC",
    side: "long",
    entryPrice: 100,
    size: 100,
    leverage: 10,
    openedAt: "",
    placedAt: "",
    orderType: "market",
    status: "open",
    thesis: { text: "x", targetPrice: 120, invalidationPrice: 95, conviction: 3 },
    proof: { hash: "h", status: "local" },
    alertsSent: [],
  };
  assert.deepEqual(crossedLevels(base, 121), ["target"]);
  assert.deepEqual(crossedLevels(base, 94), ["invalidation"]); // 6 / 9.5 of the way to liq
  assert.deepEqual(crossedLevels(base, 93), ["invalidation", "liq-warning"]);
  assert.deepEqual(crossedLevels({ ...base, side: "short", thesis: { ...base.thesis, targetPrice: 80, invalidationPrice: 105 } }, 106), ["invalidation"]);
});
