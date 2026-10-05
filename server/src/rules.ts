import { complete, llmEnabled } from "./llm.js";
import { rememberLater, usd } from "./journal.js";
import { computeMetrics } from "./positions.js";
import * as store from "./store.js";
import type { Position, RuleCheck, RuleViolation, TradingRule } from "./types.js";

/**
 * Personal trading rules, distilled from the user's own lessons, notes and chat.
 * Each rule is also written to Walrus Memory as a "[RULE]" memory, so it travels with the
 * user's memory (including into their own account) and the coach can recall it by meaning.
 * Rules with a machine-checkable `check` are enforced on every new position.
 */

const MAJORS = new Set(["BTC", "ETH"]);

export type Candidate = Pick<Position, "type" | "side" | "symbol" | "leverage" | "size" | "entryPrice"> & {
  thesis: Pick<Position["thesis"], "targetPrice" | "invalidationPrice" | "invalidationText">;
};

/** Pure: which of the user's rules would this position break? */
export function evaluateRules(rules: TradingRule[], c: Candidate): RuleViolation[] {
  const out: RuleViolation[] = [];
  const cost = c.type === "perp" ? c.size : c.size * c.entryPrice;
  for (const rule of rules) {
    const check = rule.check;
    if (!check) continue;
    const v = (detail: string) => out.push({ ruleId: rule.id, rule: rule.text, detail });
    switch (check.type) {
      case "maxLeverage": {
        const inScope =
          check.scope === "all" || (check.scope === "alts" ? !MAJORS.has(c.symbol) : MAJORS.has(c.symbol));
        if (inScope && c.type === "perp" && c.leverage > check.value) v(`${c.leverage}x is above your max of ${check.value}x`);
        break;
      }
      case "maxMarginUsd":
        if (cost > check.value) v(`${usd(cost)} at risk is above your max of ${usd(check.value)}`);
        break;
      case "requireInvalidation":
        if (!c.thesis.invalidationPrice && !c.thesis.invalidationText) v("No invalidation set");
        break;
      case "minRiskReward": {
        const { targetPrice, invalidationPrice } = c.thesis;
        if (!targetPrice || !invalidationPrice) {
          v(`Set a target and an invalidation price to check your 1:${check.value} minimum`);
          break;
        }
        const reward = computeMetrics(c, targetPrice).pnl;
        const risk = -computeMetrics(c, invalidationPrice).pnl;
        const rr = risk > 0 ? reward / risk : Infinity;
        if (rr < check.value) v(`Risk/reward is 1:${rr.toFixed(1)}, your minimum is 1:${check.value}`);
        break;
      }
      case "avoidSymbol":
        if (c.symbol === check.symbol.toUpperCase()) v(`You decided to stay away from ${check.symbol.toUpperCase()}`);
        break;
      case "noShorts":
        if (c.side === "short") v("You decided not to short");
        break;
    }
  }
  return out;
}

function sanitizeCheck(raw: unknown): RuleCheck | undefined {
  const c = (raw ?? {}) as Record<string, unknown>;
  const n = Number(c.value);
  switch (c.type) {
    case "maxLeverage":
      return n >= 1 ? { type: "maxLeverage", value: n, scope: c.scope === "alts" || c.scope === "btc-eth" ? c.scope : "all" } : undefined;
    case "maxMarginUsd":
      return n > 0 ? { type: "maxMarginUsd", value: n } : undefined;
    case "requireInvalidation":
      return { type: "requireInvalidation" };
    case "minRiskReward":
      return n > 0 ? { type: "minRiskReward", value: n } : undefined;
    case "avoidSymbol":
      return typeof c.symbol === "string" && c.symbol.trim() ? { type: "avoidSymbol", symbol: c.symbol.trim().toUpperCase() } : undefined;
    case "noShorts":
      return { type: "noShorts" };
    default:
      return undefined;
  }
}

const CHECK_SPEC = `"check" is one of (or null if the rule can't be checked automatically):
{"type":"maxLeverage","value":number,"scope":"all"|"alts"|"btc-eth"}
{"type":"maxMarginUsd","value":number}   (max USD put into one position)
{"type":"requireInvalidation"}
{"type":"minRiskReward","value":number}  (e.g. 2 for 1:2)
{"type":"avoidSymbol","symbol":"TICKER"}
{"type":"noShorts"}`;

async function llmRules(prompt: string): Promise<Array<{ text: string; check?: RuleCheck }>> {
  const raw = await complete([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 400 });
  const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const rules = Array.isArray(json.rules) ? json.rules : [];
  return rules
    .filter((r: { text?: unknown }) => typeof r?.text === "string" && r.text.trim().length >= 5)
    .slice(0, 3)
    .map((r: { text: string; check?: unknown }) => ({ text: r.text.trim().slice(0, 200), check: sanitizeCheck(r.check) }));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function describeCheck(c: RuleCheck): string {
  switch (c.type) {
    case "maxLeverage":
      return `max ${c.value}x leverage${c.scope === "alts" ? " on altcoins" : c.scope === "btc-eth" ? " on BTC/ETH" : ""}`;
    case "maxMarginUsd":
      return `max ${usd(c.value)} per position`;
    case "requireInvalidation":
      return "every position needs an invalidation";
    case "minRiskReward":
      return `risk/reward at least 1:${c.value}`;
    case "avoidSymbol":
      return `no ${c.symbol} trades`;
    case "noShorts":
      return "no shorts";
  }
}

function saveRule(userId: string, text: string, check: RuleCheck | undefined, source: TradingRule["source"]): TradingRule {
  const rule = store.addRule({ id: store.newId(), userId, text, check, source, createdAt: new Date().toISOString() });
  const memoryText =
    `[RULE] ${new Date().toISOString().slice(0, 10)} · Personal trading rule (from ${source}): ${text}` +
    (check ? ` (enforced: ${describeCheck(check)})` : " (reminder)");
  const { entry } = rememberLater(userId, "rule", memoryText);
  store.updateRule(rule.id, { journalId: entry.id });
  return { ...rule, journalId: entry.id };
}

/**
 * Looks for durable rules ("never", "always", "max", "I will only…") in something the user wrote.
 * Silently does nothing without an LLM or when the text holds no rule.
 */
export async function extractRules(userId: string, text: string, source: Exclude<TradingRule["source"], "manual">) {
  if (!llmEnabled || text.trim().length < 12) return [];
  const existing = store.rulesFor(userId);
  try {
    const found = await llmRules(
      `A trader wrote this ${source}:\n"""${text.slice(0, 1500)}"""\n\n` +
        `Extract only DURABLE personal trading rules they commit to for the future (never/always/max/only/"I will"…). ` +
        `Ignore one-off observations, market opinions and feelings. Most texts contain no rule — then return {"rules":[]}.\n` +
        `Already known rules (do not repeat): ${JSON.stringify(existing.map((r) => r.text))}\n` +
        `Write each rule as a short imperative in the trader's language. Respond ONLY with JSON: {"rules":[{"text":string,"check":object|null}]}\n${CHECK_SPEC}`,
    );
    const known = new Set(existing.map((r) => norm(r.text)));
    return found.filter((r) => !known.has(norm(r.text))).map((r) => saveRule(userId, r.text, r.check, source));
  } catch (err) {
    console.error("[rules] extraction failed:", (err as Error).message);
    return [];
  }
}

/** A rule typed by the user. The LLM only turns it into a check; the user's wording is kept. */
export async function addManualRule(userId: string, text: string) {
  const clean = text.trim().slice(0, 200);
  let check: RuleCheck | undefined;
  if (llmEnabled) {
    try {
      const [parsed] = await llmRules(
        `Turn this trading rule into a machine check if possible:\n"${clean}"\n` +
          `Respond ONLY with JSON: {"rules":[{"text":${JSON.stringify(clean)},"check":object|null}]}\n${CHECK_SPEC}`,
      );
      check = parsed?.check;
    } catch {
      // keep it as a reminder-only rule
    }
  }
  return saveRule(userId, clean, check, "manual");
}

export function deleteRule(userId: string, id: string) {
  const removed = store.removeRule(userId, id);
  if (removed) {
    // Walrus Memory is append-only: record the change so recall knows the rule was dropped.
    rememberLater(userId, "rule", `[RULE REMOVED] ${new Date().toISOString().slice(0, 10)} · User dropped the rule: ${removed.text}`);
  }
  return removed;
}
