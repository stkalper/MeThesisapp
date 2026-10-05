import { complete, detectLanguage, languageInstruction, llmEnabled } from "./llm.js";
import { rememberLater } from "./journal.js";
import { recallFor } from "./memory.js";
import * as store from "./store.js";
import type { Position } from "./types.js";

/**
 * Thesis drift: traders enter for one reason and keep holding for another ("ETF inflows" → "it'll come back").
 * When the user talks about an open position, the original thesis is recalled from Walrus Memory and compared
 * with the reason they give *now*. A drift is written back as a [DRIFT] memory on that position, so the
 * coach, later alerts and the trade's post-mortem all see it.
 */

export interface Drift {
  positionId: string;
  symbol: string;
  /** Short summary of why the user entered, taken from the sealed thesis. */
  original: string;
  /** Short summary of the reason they give now. */
  now: string;
  note: string;
  /** When the thesis was written (YYYY-MM-DD). */
  thesisDate: string;
  journalId?: string;
}

/** The thesis exactly as sealed in Walrus Memory; falls back to the local copy if recall misses it. */
async function sealedThesis(p: Position): Promise<string> {
  const recalled = await recallFor(p.userId, `[THESIS] ${p.side} ${p.symbol} ${p.type}: why I entered`, 6).catch(() => []);
  return recalled.find((m) => m.text.includes(`Position ${p.id}`))?.text ?? `Why: ${p.thesis.text}`;
}

/** Don't record the same drift twice when the user repeats themselves within a few messages. */
const RECENT_MS = 30 * 60_000;
function recentlyRecorded(p: Position): boolean {
  return store
    .journalFor(p.userId, p.id)
    .some((j) => j.kind === "drift" && Date.now() - Date.parse(j.createdAt) < RECENT_MS);
}

export async function detectDrift(p: Position, statement: string): Promise<Drift | null> {
  if (!llmEnabled || p.status !== "open" || statement.trim().length < 20) return null;
  const thesis = await sealedThesis(p);
  const raw = await complete(
    [
      {
        role: "system",
        content:
          "You check whether a trader's reason for being in a position has drifted from their original thesis. " +
          'Respond ONLY with JSON: {"drift": "drifted"|"same"|"no_reason", "original": string (max 12 words, why they entered), ' +
          '"now": string (max 12 words, the reason they give now), "note": string (one sentence, factual, no advice)}. ' +
          '"drifted" ONLY if the message states a reason to hold, add or stay that is different in kind from the original thesis ' +
          "(hope of a bounce, sunk cost, a new unrelated narrative, someone else's opinion). " +
          'Fear, doubt or excitement alone is "no_reason". A reason consistent with the thesis is "same". ' +
          languageInstruction(statement).replace("reply", "original/now/note"),
      },
      {
        role: "user",
        content:
          `ORIGINAL THESIS (sealed in Walrus Memory):\n${thesis}\n\nWHAT THEY SAY NOW:\n${statement.slice(0, 1500)}` +
          (detectLanguage(statement) ? `\n\n(Write original/now/note in ${detectLanguage(statement)}.)` : ""),
      },
    ],
    { temperature: 0, maxTokens: 220 },
  );
  let json: { drift?: string; original?: string; now?: string; note?: string };
  try {
    json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  if (json.drift !== "drifted" || !json.original || !json.now) return null;

  const drift: Drift = {
    positionId: p.id,
    symbol: p.symbol,
    original: String(json.original).slice(0, 160),
    now: String(json.now).slice(0, 160),
    note: String(json.note ?? "").slice(0, 300),
    thesisDate: p.placedAt.slice(0, 10),
  };
  if (!recentlyRecorded(p)) {
    const iso = new Date().toISOString();
    const text =
      `[DRIFT] ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC · ${p.side.toUpperCase()} ${p.symbol} ${p.type}: ` +
      `entered because "${drift.original}" (thesis of ${drift.thesisDate}), now holding because "${drift.now}". ` +
      `Position ${p.id}.`;
    drift.journalId = rememberLater(p.userId, "drift", text, p.id).entry.id;
  }
  return drift;
}
