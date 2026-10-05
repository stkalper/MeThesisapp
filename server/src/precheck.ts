import { walruscanBlobUrl } from "./config.js";
import { complete, llmEnabled } from "./llm.js";
import { recallFor } from "./memory.js";
import { computeMetrics } from "./positions.js";
import { evaluateRules, type Candidate } from "./rules.js";
import * as store from "./store.js";
import type { Position } from "./types.js";

/**
 * "Before you enter": while the user fills in a new position, look up what their memory says
 * about trades like this one — similar past theses, check-ins and outcomes recalled from
 * Walrus Memory, plus their record on this asset and any personal rule this trade would break.
 */

const WIPED_PCT = -90; // a closed perp losing ≥90% of margin is treated as (near) liquidation

interface Record_ {
  count: number;
  wins: number;
  avgPnlPct: number | null;
  wiped: number;
}

function record(positions: Position[]): Record_ {
  const results = positions.map((p) => computeMetrics(p, p.exitPrice!).pnlPct);
  return {
    count: results.length,
    wins: results.filter((r) => r > 0).length,
    avgPnlPct: results.length ? results.reduce((a, b) => a + b, 0) / results.length : null,
    wiped: results.filter((r) => r <= WIPED_PCT).length,
  };
}

export async function precheck(userId: string, c: Candidate & { thesisText?: string }, explain = true) {
  const closed = store.positionsFor(userId).filter((p) => p.status === "closed" && p.exitPrice);
  const sameSymbol = record(closed.filter((p) => p.symbol === c.symbol));
  const highLeverage =
    c.type === "perp" && c.leverage >= 5 ? record(closed.filter((p) => p.type === "perp" && p.leverage >= Math.min(c.leverage, 10))) : null;
  const violations = evaluateRules(store.rulesFor(userId), c);

  const setup = `${c.side} ${c.symbol} ${c.type}${c.type === "perp" ? ` ${c.leverage}x leverage` : ""}`;
  const queries = [
    `how did my ${setup} trades go, outcome and lesson`,
    `feelings, panic or mistakes on ${c.symbol}`,
    ...(c.thesisText && c.thesisText.trim().length >= 15 ? [c.thesisText] : []),
    ...(c.type === "perp" && c.leverage >= 10 ? ["high leverage liquidation regret"] : []),
  ];
  const settled = await Promise.allSettled(queries.map((q) => recallFor(userId, q, 4)));
  const seen = new Set<string>();
  const similar = settled
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => a.distance - b.distance)
    // Rules and removed rules are reported separately; the user's own open thesis isn't "history".
    .filter((m) => !/^\[RULE/u.test(m.text) && (seen.has(m.text) ? false : (seen.add(m.text), true)))
    .filter((m) => m.distance < 0.7)
    .slice(0, 4)
    .map((m) => ({ ...m, proofUrl: m.blobId ? walruscanBlobUrl(m.blobId) : undefined }));

  let summary: string | undefined;
  if (explain && llmEnabled && (similar.length || violations.length || sameSymbol.count)) {
    try {
      summary = await complete(
        [
          {
            role: "system",
            content:
              "You are a trading-discipline coach. In at most 2 short sentences, warn the trader about what THEIR OWN history says " +
              "about the trade they are about to open. Cite dates from the memories. If history looks fine, say so briefly. " +
              "Never tell them to buy or sell. Reply in the language of the thesis if given, else English.",
          },
          {
            role: "user",
            content:
              `ABOUT TO OPEN: ${setup} at ${c.entryPrice}. Thesis: ${c.thesisText || "(not written yet)"}\n` +
              `RECORD ON ${c.symbol}: ${JSON.stringify(sameSymbol)}\n` +
              (highLeverage ? `RECORD WITH HIGH LEVERAGE: ${JSON.stringify(highLeverage)}\n` : "") +
              `RULES BROKEN: ${violations.map((v) => `${v.rule} (${v.detail})`).join("; ") || "none"}\n` +
              `MEMORIES:\n${similar.map((m) => `- ${m.text}`).join("\n") || "(none)"}`,
          },
        ],
        { temperature: 0.3, maxTokens: 160 },
      );
    } catch (err) {
      console.error("[precheck] summary failed:", (err as Error).message);
    }
  }

  return { violations, similar, record: { sameSymbol, highLeverage }, summary };
}
