import { complete, llmEnabled } from "./llm.js";
import { describePosition, rememberLater, usd } from "./journal.js";
import { recallFor } from "./memory.js";
import { computeMetrics } from "./positions.js";
import * as store from "./store.js";
import type { PostMortem, Position } from "./types.js";

/**
 * Trade post-mortem: when a position closes, rebuild the story of the trade from its memories —
 * the thesis, every check-in and alert, and related memories recalled from Walrus Memory
 * (e.g. how the user behaved on this asset before) — and distil one lesson.
 * The story is written back to Walrus Memory, so future recalls get the *interpreted* history,
 * not just raw events.
 */

async function context(p: Position): Promise<string> {
  // This position's own memories, oldest first (exact texts as stored on Walrus).
  const own = store
    .journalFor(p.userId, p.id)
    .slice()
    .reverse()
    .map((j) => j.text);
  // Plus what Walrus Memory associates with this trade beyond its own entries.
  const recalled = await recallFor(p.userId, `${p.symbol} ${p.side} trade: feelings, mistakes and lessons`, 6).catch(() => []);
  const extra = recalled.map((m) => m.text).filter((t) => !own.includes(t) && !t.includes(`Position ${p.id}`));
  return [
    "THIS TRADE'S MEMORIES (chronological):",
    ...own.map((t) => `- ${t}`),
    "",
    "RELATED MEMORIES FROM EARLIER TRADES:",
    ...(extra.length ? extra.slice(0, 4).map((t) => `- ${t}`) : ["(none)"]),
  ].join("\n");
}

/** Writes the story + a suggested lesson. Pure suggestion — nothing is stored. */
export async function draft(p: Position, exitPrice: number): Promise<Omit<PostMortem, "createdAt" | "journalId">> {
  const m = computeMetrics(p, exitPrice);
  const days = Math.max(0, Math.round((Date.now() - Date.parse(p.openedAt)) / 86_400_000));
  const fallback = {
    story: `${describePosition(p)} held ${days} day(s), closing at ${usd(exitPrice)} for ${m.pnl >= 0 ? "a profit" : "a loss"} of ${usd(m.pnl)} (${m.pnlPct.toFixed(1)}%).`,
    lesson: "",
    followedPlan: "unclear" as const,
  };
  if (!llmEnabled) return fallback;

  const raw = await complete(
    [
      {
        role: "system",
        content:
          "You write short, honest post-mortems of a trader's closed trade from their own journal. " +
          'Respond ONLY with JSON: {"story": string (3-4 sentences: why they entered, how they behaved during the trade — ' +
          'cite check-ins and their dates —, and how it ended), "lesson": string (ONE concrete, reusable sentence in first person, ' +
          'e.g. "I sit through -5% shakeouts when my invalidation is intact"), "followedPlan": "yes"|"partly"|"no"|"unclear"}. ' +
          "If there are [DRIFT] memories, say how the reason for holding changed from the original thesis and when. " +
          "Use only facts from the memories. Same language as the thesis.",
      },
      {
        role: "user",
        content:
          `CLOSING NOW: ${describePosition(p)} at ${usd(exitPrice)} after ${days} day(s), result ${usd(m.pnl)} (${m.pnlPct.toFixed(1)}%). ` +
          `Target was ${p.thesis.targetPrice ? usd(p.thesis.targetPrice) : "n/a"}, invalidation ${p.thesis.invalidationPrice ? usd(p.thesis.invalidationPrice) : p.thesis.invalidationText ?? "n/a"}.\n\n` +
          (await context(p)),
      },
    ],
    { temperature: 0.3, maxTokens: 450 },
  );
  try {
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      story: String(json.story ?? fallback.story).slice(0, 1200),
      lesson: String(json.lesson ?? "").slice(0, 300),
      followedPlan: ["yes", "partly", "no"].includes(json.followedPlan) ? json.followedPlan : "unclear",
    };
  } catch {
    return fallback;
  }
}

/** After close: generate the post-mortem and seal it into Walrus Memory. */
export async function writePostMortem(positionId: string) {
  const p = store.getPosition(positionId);
  if (!p || p.status !== "closed" || !p.exitPrice) return;
  try {
    const pm = await draft(p, p.exitPrice);
    const text =
      `[POST-MORTEM] ${new Date().toISOString().slice(0, 10)} · ${p.side.toUpperCase()} ${p.symbol} ${p.type} trade review: ${pm.story}` +
      ` Followed own plan: ${pm.followedPlan}.` +
      (pm.lesson ? ` Lesson: ${pm.lesson}` : "") +
      (p.lesson ? ` (User's own lesson: ${p.lesson})` : "");
    const { entry } = rememberLater(p.userId, "postmortem", text, p.id);
    store.updatePosition(p.id, { postmortem: { ...pm, createdAt: new Date().toISOString(), journalId: entry.id } });
  } catch (err) {
    console.error(`[postmortem] ${positionId} failed:`, (err as Error).message);
  }
}
