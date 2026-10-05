import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, type Candidate } from "./rules.js";
import type { RuleCheck, TradingRule } from "./types.js";

const rule = (check: RuleCheck, text = "rule"): TradingRule => ({
  id: text,
  userId: "u",
  text,
  check,
  source: "manual",
  createdAt: "",
});

const perp = (over: Partial<Candidate> = {}): Candidate => ({
  type: "perp",
  side: "long",
  symbol: "SOL",
  leverage: 10,
  size: 200, // margin
  entryPrice: 100,
  thesis: { targetPrice: 120, invalidationPrice: 95 },
  ...over,
});

test("max leverage respects scope (alts vs majors)", () => {
  const alts = [rule({ type: "maxLeverage", value: 5, scope: "alts" })];
  assert.equal(evaluateRules(alts, perp()).length, 1);
  assert.equal(evaluateRules(alts, perp({ symbol: "BTC" })).length, 0);
  assert.equal(evaluateRules(alts, perp({ leverage: 5 })).length, 0);
  assert.equal(evaluateRules(alts, perp({ type: "spot", leverage: 1 })).length, 0);
});

test("risk/reward minimum uses target and invalidation", () => {
  const rr2 = [rule({ type: "minRiskReward", value: 2 })];
  // long 100 → target 120 (+20) vs invalidation 95 (-5): 1:4
  assert.equal(evaluateRules(rr2, perp()).length, 0);
  // 2x so the invalidation is reached before liquidation: -15 vs +20 → 1:1.3
  assert.match(evaluateRules(rr2, perp({ leverage: 2, thesis: { targetPrice: 120, invalidationPrice: 85 } }))[0]!.detail, /1:1\.3/);
  assert.equal(evaluateRules(rr2, perp({ thesis: {} })).length, 1, "missing levels are flagged");
});

test("margin cap, invalidation, symbol and no-shorts rules", () => {
  const rules = [
    rule({ type: "maxMarginUsd", value: 100 }, "cap"),
    rule({ type: "requireInvalidation" }, "inv"),
    rule({ type: "avoidSymbol", symbol: "sol" }, "nosol"),
    rule({ type: "noShorts" }, "noshort"),
  ];
  const ids = evaluateRules(rules, perp({ side: "short", thesis: {} })).map((v) => v.ruleId);
  assert.deepEqual(ids.sort(), ["cap", "inv", "noshort", "nosol"]);
  // spot cost = qty * price
  assert.equal(evaluateRules([rules[0]!], { ...perp(), type: "spot", leverage: 1, size: 0.5 }).length, 0);
});

test("reminder-only rules never block", () => {
  const reminder: TradingRule = { id: "r", userId: "u", text: "Don't trade on news", source: "note", createdAt: "" };
  assert.equal(evaluateRules([reminder], perp()).length, 0);
});
