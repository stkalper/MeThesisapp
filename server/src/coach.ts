import { complete, detectLanguage, languageInstruction, llmEnabled, type LlmMessage } from "./llm.js";
import { analyzeFor, recallFor, type RecalledMemory } from "./memory.js";
import { extractRules } from "./rules.js";
import { computeMetrics, type LevelEvent } from "./positions.js";
import { getQuotes } from "./prices.js";
import { describePosition, usd } from "./journal.js";
import { detectDrift, type Drift } from "./drift.js";
import * as store from "./store.js";
import type { Position } from "./types.js";

/**
 * The coach turns Walrus Memory into behaviour change:
 *  - in chat, it recalls past theses / emotions / lessons related to what the user is saying now;
 *  - on price alerts, it reminds the user of what *they* wrote when calm;
 *  - in insights, it mines the whole memory space for recurring patterns.
 */

const SYSTEM_PROMPT = `You are Thesis Keeper — a calm, sharp trading-discipline coach living in Telegram.
Your job is NOT to predict prices or give financial advice. Your job is to hold the user accountable
to the theses they wrote down when they were calm, and to surface their own past patterns.

You receive:
- MEMORIES: entries recalled from the user's encrypted Walrus Memory (theses, check-ins, outcomes, notes). Each is dated.
- POSITIONS: the user's open positions with live PnL.

Rules:
- Ground every claim about the user's past in MEMORIES. Quote or paraphrase them with their date ("On Oct 2 you wrote …").
- If the user wants to exit/enter emotionally, ask whether the written invalidation actually happened.
- Point out contradictions between what they say now and what they wrote before.
- If memories don't cover something, say you don't have it on record — never invent history.
- Be concise: 2–6 short sentences or a few bullets. No hype, no emojis spam (one is fine).
- Reply in the same language the user writes in.
- Never tell the user to buy, sell, hold or close — not even "you shouldn't close". Instead state the facts
  (their rule vs. the current price) and end with a question that makes them check their own rule.`;

async function positionsContext(userId: string) {
  const open = store.positionsFor(userId).filter((p) => p.status === "open" || p.status === "pending");
  if (!open.length) return { text: "No open positions or pending orders.", open };
  const quotes = await getQuotes(open.map((p) => p.symbol)).catch(() => ({}) as Record<string, { price: number }>);
  const lines = open.map((p) => {
    const mark = quotes[p.symbol]?.price;
    if (p.status === "pending") {
      return (
        `- PENDING LIMIT ORDER (not filled yet): ${describePosition(p)}, placed ${p.placedAt.slice(0, 10)}; ` +
        `market now ${mark ? usd(mark) : "unavailable"}. Target ${p.thesis.targetPrice ? usd(p.thesis.targetPrice) : "n/a"}.`
      );
    }
    if (!mark) return `- ${describePosition(p)} — price unavailable`;
    const m = computeMetrics(p, mark);
    const liq = m.liquidationPrice ? `, liq ≈ ${usd(m.liquidationPrice)}` : "";
    return (
      `- ${describePosition(p)} opened ${p.openedAt.slice(0, 10)} — now ${usd(mark)}, PnL ${usd(m.pnl)} (${m.pnlPct.toFixed(1)}%)${liq}. ` +
      `Target ${p.thesis.targetPrice ? usd(p.thesis.targetPrice) : "n/a"}, invalidation ${
        p.thesis.invalidationPrice ? usd(p.thesis.invalidationPrice) : p.thesis.invalidationText ?? "n/a"
      }.`
    );
  });
  return { text: lines.join("\n"), open };
}

function dedupe(memories: RecalledMemory[]): RecalledMemory[] {
  const seen = new Set<string>();
  return memories
    .sort((a, b) => a.distance - b.distance)
    .filter((m) => (seen.has(m.text) ? false : (seen.add(m.text), true)));
}

async function recallMany(userId: string, queries: string[], limit = 6): Promise<RecalledMemory[]> {
  const settled = await Promise.allSettled(queries.map((q) => recallFor(userId, q, limit)));
  return dedupe(settled.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
}

const formatMemories = (ms: RecalledMemory[]) =>
  ms.length ? ms.map((m) => `- ${m.text}`).join("\n") : "(no relevant memories on record yet)";

export interface CoachReply {
  reply: string;
  memoriesUsed: RecalledMemory[];
  drift: Drift[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One short line per recalled memory: "Thesis · Oct 4 — Opened LONG BTC perp @ $78,000…". */
export function receiptLine(text: string, max = 70): string {
  const m = text.match(/^\[([A-Z-]+)\]\s+(\d{4})-(\d{2})-(\d{2})[^·]*·\s*/);
  if (!m) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const tag = m[1]!.charAt(0) + m[1]!.slice(1).toLowerCase();
  const body = text.slice(m[0].length);
  return `${tag} · ${MONTHS[Number(m[3]) - 1]} ${Number(m[4])} — ${body.length > max ? `${body.slice(0, max - 1)}…` : body}`;
}

/** Footer for Telegram replies that shows which memories the answer was grounded in. */
export function memoryReceipt(memories: RecalledMemory[], limit = 3): string {
  if (!memories.length) return "";
  return `\n\n🧠 Recalled from your Walrus Memory:\n${memories.slice(0, limit).map((m) => `• ${receiptLine(m.text)}`).join("\n")}`;
}

export async function chat(userId: string, message: string, opts: { position?: Position } = {}): Promise<CoachReply> {
  const { text: posText, open } = await positionsContext(userId);
  // Recall by what the user said, plus the theses of any positions they mention by ticker.
  const mentioned = opts.position
    ? [opts.position]
    : open.filter((p) => new RegExp(`\\b${p.symbol}\\b`, "i").test(message));
  const queries = [message, ...mentioned.map((p) => `thesis and invalidation for ${p.symbol} ${p.type}`)];
  const started = Date.now();
  const ms: Record<string, number> = {};
  const timed = <T,>(label: string, p: Promise<T>) => p.finally(() => void (ms[label] = Date.now() - started));
  // Drift check runs alongside recall: is the reason they give now still the reason they entered for?
  const [recalled, drifts] = await Promise.all([
    timed("recall", recallMany(userId, queries)),
    timed(
      "drift",
      Promise.all(
        mentioned
          .filter((p) => p.status === "open")
          .slice(0, 2)
          .map((p) => detectDrift(p, message).catch(() => null)),
      ),
    ),
  ]);
  const memoriesUsed = recalled.slice(0, 10);
  const drift = drifts.filter((d): d is Drift => d !== null);

  let reply: string;
  if (llmEnabled) {
    const history: LlmMessage[] = store
      .chatHistory(userId)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    const checkInContext = opts.position
      ? `\n\nTHIS MESSAGE IS A CHECK-IN on: ${describePosition(opts.position)}, opened ${opts.position.openedAt.slice(0, 10)}.`
      : "";
    const driftContext = drift.length
      ? "\n\nTHESIS DRIFT DETECTED — raise this first, quoting the thesis date, and ask whether the original reason still holds:\n" +
        drift.map((d) => `- ${d.symbol}: entered on ${d.thesisDate} because "${d.original}"; now the reason is "${d.now}". ${d.note}`).join("\n")
      : "";
    reply = await complete([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nMEMORIES:\n${formatMemories(memoriesUsed)}\n\nPOSITIONS:\n${posText}${checkInContext}${driftContext}`,
      },
      ...history,
      // Placed last so earlier English turns or English memories don't pull the reply into English.
      { role: "system", content: languageInstruction(message) },
      // A short note inside the user turn itself is what reliably keeps open models in the user's language.
      { role: "user", content: detectLanguage(message) ? `${message}\n\n(Answer in ${detectLanguage(message)}.)` : message },
    ]);
  } else {
    reply = memoriesUsed.length
      ? `Here is what I have on record that relates to this:\n${memoriesUsed.slice(0, 5).map((m) => `• ${m.text}`).join("\n")}`
      : "I don't have anything on record about that yet. Add a position with a thesis in the app, and I'll hold you to it.";
  }

  console.log(
    `[coach] reply in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(recall ${((ms.recall ?? 0) / 1000).toFixed(1)}s, drift ${((ms.drift ?? 0) / 1000).toFixed(1)}s, ${memoriesUsed.length} memories)`,
  );
  const at = new Date().toISOString();
  store.pushChat(userId, { role: "user", content: message, at });
  store.pushChat(userId, { role: "assistant", content: reply, at });

  // Let Walrus Memory distil durable facts (risk rules, beliefs, preferences) from the conversation,
  // and turn any rule the user commits to ("never more than 5x") into an enforced personal rule.
  if (message.trim().length >= 25) {
    void learnFromChat(userId, message);
    void extractRules(userId, message, "chat");
  }

  return { reply, memoriesUsed, drift };
}

async function learnFromChat(userId: string, message: string) {
  try {
    const { facts, space, mode } = await analyzeFor(userId, message);
    for (const fact of facts) {
      store.addJournal({
        id: store.newId(),
        userId,
        kind: "chat",
        text: fact.text,
        createdAt: new Date().toISOString(),
        memory: {
          status: mode === "local" ? "local" : fact.ok ? "stored" : "failed",
          blobId: fact.blobId,
          space,
        },
      });
    }
  } catch (err) {
    console.error("[memory] analyze failed:", (err as Error).message);
  }
}

// ---- alerts ----

const EVENT_COPY: Record<LevelEvent, string> = {
  target: "hit your TARGET",
  invalidation: "crossed your INVALIDATION level",
  "liq-warning": "is getting close to LIQUIDATION",
  liquidated: "was LIQUIDATED",
};

export async function alertMessage(p: Position, event: LevelEvent, mark: number): Promise<string> {
  const m = computeMetrics(p, mark);
  const memoriesUsed = await recallMany(p.userId, [
    `thesis for ${p.symbol}`,
    `how I felt and reacted when ${p.symbol} moved against me`,
    "lessons learned from closing positions",
  ]);
  const header = `${p.symbol} ${EVENT_COPY[event]} — now ${usd(mark)} (PnL ${usd(m.pnl)}, ${m.pnlPct.toFixed(1)}%).`;
  const fallback =
    `${header}\n\nWhen you opened this trade you wrote:\n“${p.thesis.text}”\n` +
    (p.thesis.invalidationPrice || p.thesis.invalidationText
      ? `Your invalidation: ${[p.thesis.invalidationPrice && usd(p.thesis.invalidationPrice), p.thesis.invalidationText].filter(Boolean).join(" / ")}.`
      : "");
  if (!llmEnabled) return fallback;
  try {
    const lang = store.getUser(p.userId)?.languageCode ?? "en";
    const body = await complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Write a short Telegram alert (max 5 sentences, language code "${lang}").\n` +
            `EVENT: ${header}\nPOSITION: ${describePosition(p)}, opened ${p.openedAt.slice(0, 10)}.\n` +
            `THESIS: ${p.thesis.text}\nTARGET: ${p.thesis.targetPrice ?? "n/a"} INVALIDATION: ${p.thesis.invalidationPrice ?? ""} ${p.thesis.invalidationText ?? ""}\n` +
            `MEMORIES:\n${formatMemories(memoriesUsed)}\n\n` +
            `Remind them of their own plan for this exact situation and of any relevant past behaviour. End with one question.`,
        },
      ],
      { maxTokens: 300 },
    );
    return `${header}\n\n${body}`;
  } catch {
    return fallback;
  }
}

// ---- insights ----

export interface Insights {
  headline: string;
  patterns: Array<{ title: string; evidence: string; advice: string }>;
  stats: {
    closed: number;
    winRate: number | null;
    thesisAccuracy: number | null;
    avgHoldDays: number | null;
    memories: number;
  };
  generatedAt: string;
}

const insightsCache = new Map<string, { at: number; value: Insights }>();

export async function insights(userId: string, force = false): Promise<Insights> {
  const cached = insightsCache.get(userId);
  if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached.value;

  const closed = store.positionsFor(userId).filter((p) => p.status === "closed" && p.exitPrice);
  const wins = closed.filter((p) => computeMetrics(p, p.exitPrice!).pnl > 0).length;
  const judged = closed.filter((p) => p.thesisOutcome && p.thesisOutcome !== "unclear");
  const right = judged.filter((p) => p.thesisOutcome === "right").length + 0.5 * judged.filter((p) => p.thesisOutcome === "partial").length;
  const holds = closed.map((p) => (Date.parse(p.closedAt!) - Date.parse(p.openedAt)) / 86_400_000);
  const stats: Insights["stats"] = {
    closed: closed.length,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    thesisAccuracy: judged.length ? Math.round((right / judged.length) * 100) : null,
    avgHoldDays: holds.length ? Math.round((holds.reduce((a, b) => a + b, 0) / holds.length) * 10) / 10 : null,
    memories: store.journalFor(userId).length,
  };

  const memoriesUsed = await recallMany(
    userId,
    [
      "panic, fear, wanting to sell early",
      "FOMO, chasing a pump, entering late",
      "lessons learned and mistakes",
      "thesis played out and was right",
      "reacting to news or social media",
      "risk management, leverage, position size",
    ],
    5,
  );

  let value: Insights = {
    headline: memoriesUsed.length ? "Your memory is building up — keep journaling to unlock patterns." : "No memories yet — open a position with a thesis to start.",
    patterns: [],
    stats,
    generatedAt: new Date().toISOString(),
  };

  if (llmEnabled && memoriesUsed.length >= 3) {
    try {
      const raw = await complete(
        [
          {
            role: "system",
            content:
              "You analyse a trader's journal and find behavioural patterns. Respond ONLY with JSON: " +
              '{"headline": string (max 14 words), "patterns": [{"title": string (max 6 words), "evidence": string (cite dates/assets from the memories), "advice": string (one concrete rule)}]} with 2-4 patterns. ' +
              "Use only the evidence given. English.",
          },
          {
            role: "user",
            content: `STATS: ${JSON.stringify(stats)}\nMEMORIES:\n${formatMemories(memoriesUsed)}`,
          },
        ],
        { temperature: 0.3, maxTokens: 700 },
      );
      const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (typeof json.headline === "string" && Array.isArray(json.patterns)) {
        value = { ...value, headline: json.headline, patterns: json.patterns.slice(0, 4) };
      }
    } catch (err) {
      console.error("[insights] failed:", (err as Error).message);
    }
  }

  insightsCache.set(userId, { at: Date.now(), value });
  return value;
}
