import { createHash } from "node:crypto";
import { prepareCommitment, publishCommitment } from "./commitment.js";
import { rememberFor } from "./memory.js";
import { computeMetrics } from "./positions.js";
import { normalizeSymbol } from "./prices.js";
import * as store from "./store.js";
import type { JournalEntry, JournalKind, OrderType, Position, PositionType, Side, Thesis } from "./types.js";

/**
 * The journal is the bridge between the app and Walrus Memory. Every meaningful event —
 * a thesis, a wobble of conviction, an outcome and its lesson — is written as a
 * self-contained, dated, human-readable memory. Later the coach recalls these
 * by meaning ("times I panicked on news") rather than by ID.
 */

export const usd = (n: number, max = 2) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : max })}`;

const stamp = (iso = new Date().toISOString()) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const coins = (n: number) =>
  n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });

export function describePosition(p: Pick<Position, "type" | "side" | "symbol" | "leverage" | "entryPrice" | "size">) {
  const sizeText =
    p.type === "perp"
      ? `${coins((p.size * p.leverage) / p.entryPrice)} ${p.symbol} = ${usd(p.size * p.leverage)} position, margin ${usd(p.size)}, ${p.leverage}x`
      : `${coins(p.size)} ${p.symbol} = ${usd(p.size * p.entryPrice)}`;
  return `${p.side.toUpperCase()} ${p.symbol} ${p.type} @ ${usd(p.entryPrice)} (${sizeText})`;
}

/**
 * Records a journal entry and starts writing it to Walrus Memory.
 * Returns the entry immediately (status "pending") plus a promise that resolves once
 * the blob is stored — a Walrus write takes ~20s, far too long to block a reply on.
 */
export function rememberLater(
  userId: string,
  kind: JournalKind,
  text: string,
  positionId?: string,
): { entry: JournalEntry; stored: Promise<JournalEntry> } {
  const entry = store.addJournal({
    id: store.newId(),
    userId,
    positionId,
    kind,
    text,
    createdAt: new Date().toISOString(),
    memory: { status: "pending" },
  });
  return { entry: { ...entry }, stored: persistToWalrus(entry) };
}

/** Writes a memory to Walrus and resolves once it is stored (or failed). */
export function remember(userId: string, kind: JournalKind, text: string, positionId?: string): Promise<JournalEntry> {
  return rememberLater(userId, kind, text, positionId).stored;
}

async function persistToWalrus(entry: JournalEntry): Promise<JournalEntry> {
  const { userId, text } = entry;
  try {
    const stored = await rememberFor(userId, text);
    entry.memory = { status: stored.mode === "walrus" ? "stored" : "local", blobId: stored.blobId, space: stored.space };
  } catch (err) {
    entry.memory = { status: "failed", error: (err as Error).message.slice(0, 200) };
    console.error(`[memory] remember failed for ${userId}:`, (err as Error).message);
  }
  store.updateJournal(entry.id, { memory: entry.memory });
  return entry;
}

// ---- positions ----

export type SizeUnit = "margin" | "usdt" | "token";

export interface NewPositionInput {
  type: PositionType;
  symbol: string;
  side: Side;
  /** Market entry price, or the limit price for a limit order. */
  entryPrice: number;
  /** Canonical size: spot → asset quantity, perp → margin in USDT. */
  size: number;
  leverage: number;
  sizeInput?: { unit: SizeUnit; value: number };
  orderType: OrderType;
  thesis: Thesis;
}

/**
 * Converts what the user typed into the canonical size.
 *  spot: "usdt" = amount spent, "token" = quantity
 *  perp: "margin" = collateral, "usdt" = position value (notional, as on Binance/Bybit), "token" = position quantity
 */
export function canonicalSize(type: PositionType, unit: SizeUnit, value: number, entryPrice: number, leverage: number): number {
  if (type === "spot") return unit === "token" ? value : value / entryPrice;
  if (unit === "margin") return value;
  const notional = unit === "token" ? value * entryPrice : value;
  return notional / leverage;
}

// Accept "0,5" (comma decimals), spaces and "$" from mobile keyboards.
const toNum = (v: unknown) => Number(String(v ?? "").trim().replace(/[\s$]/g, "").replace(",", ".")) || NaN;

/** Parses a (possibly half-filled) position form without rejecting anything — used by the pre-trade check. */
export function parsePositionInput(raw: unknown): NewPositionInput {
  const r = (raw ?? {}) as Record<string, any>;
  const t = (r.thesis ?? {}) as Record<string, any>;
  const num = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : toNum(v));
  const type: PositionType = r.type === "perp" ? "perp" : "spot";
  const side: Side = type === "perp" && r.side === "short" ? "short" : "long";
  const leverage = type === "perp" ? Math.min(125, Math.max(1, Math.round(Number(r.leverage) || 1))) : 1;
  const entryPrice = toNum(r.entryPrice);

  let size = toNum(r.size);
  let sizeInput: NewPositionInput["sizeInput"];
  if (r.sizeInput && typeof r.sizeInput === "object") {
    const allowed: SizeUnit[] = type === "spot" ? ["usdt", "token"] : ["margin", "usdt", "token"];
    const unit: SizeUnit = allowed.includes(r.sizeInput.unit) ? r.sizeInput.unit : allowed[0]!;
    const value = toNum(r.sizeInput.value);
    sizeInput = { unit, value };
    size = entryPrice > 0 && value > 0 ? canonicalSize(type, unit, value, entryPrice, leverage) : NaN;
  }

  const input: NewPositionInput = {
    type,
    side,
    symbol: normalizeSymbol(String(r.symbol ?? "")),
    entryPrice,
    size,
    sizeInput,
    orderType: r.orderType === "limit" ? "limit" : "market",
    leverage,
    thesis: {
      text: String(t.text ?? "").trim().slice(0, 2000),
      targetPrice: num(t.targetPrice),
      invalidationPrice: num(t.invalidationPrice),
      invalidationText: t.invalidationText ? String(t.invalidationText).trim().slice(0, 500) : undefined,
      horizon: t.horizon ? String(t.horizon).trim().slice(0, 60) : undefined,
      conviction: Math.min(5, Math.max(1, Math.round(Number(t.conviction) || 3))),
    },
  };
  return input;
}

export function validatePositionInput(raw: unknown): NewPositionInput {
  const input = parsePositionInput(raw);
  const errors: string[] = [];
  if (!input.symbol) errors.push("symbol is required");
  if (!(input.entryPrice > 0)) errors.push("entryPrice must be > 0");
  if (!(input.size > 0)) errors.push("size must be > 0");
  if (input.thesis.text.length < 10) errors.push("thesis must be at least 10 characters — why are you taking this trade?");
  for (const k of ["targetPrice", "invalidationPrice"] as const) {
    const v = input.thesis[k];
    if (v !== undefined && !(v > 0)) errors.push(`${k} must be > 0`);
  }
  if (errors.length) throw new ValidationError(errors.join("; "));
  return input;
}

export class ValidationError extends Error {}

export function thesisHash(p: Position): string {
  const canonical = JSON.stringify({
    userId: p.userId,
    symbol: p.symbol,
    type: p.type,
    side: p.side,
    entryPrice: p.entryPrice,
    size: p.size,
    leverage: p.leverage,
    orderType: p.orderType,
    placedAt: p.placedAt,
    thesis: p.thesis,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function thesisMemoryText(p: Position): string {
  const t = p.thesis;
  const action =
    p.orderType === "limit"
      ? `Placed LIMIT order ${describePosition(p)} — not filled yet, market was ${usd(p.refPrice ?? p.entryPrice)}.`
      : `Opened ${describePosition(p)}.`;
  const parts = [
    `[THESIS] ${stamp(p.placedAt)} · ${action}`,
    `Why: ${/[.!?]$/u.test(t.text) ? t.text : `${t.text}.`}`,
    t.targetPrice ? `Target: ${usd(t.targetPrice)}.` : "",
    t.invalidationPrice || t.invalidationText
      ? `Invalidation: ${[t.invalidationPrice && usd(t.invalidationPrice), t.invalidationText].filter(Boolean).join(" / ")}.`
      : "",
    t.horizon ? `Horizon: ${t.horizon}.` : "",
    `Conviction: ${t.conviction}/5.`,
    p.ruleViolations?.length
      ? `Knowingly broke own rules: ${p.ruleViolations.map((v) => `"${v.rule}" (${v.detail})`).join("; ")}.`
      : "",
    `Position ${p.id}. Proof sha256:${p.proof.hash}`,
    p.commitment ? `Public commitment sha256:${p.commitment.hash} (${p.commitment.network}).` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export async function openPosition(
  userId: string,
  input: NewPositionInput,
  marketPrice?: number,
  ruleViolations?: Position["ruleViolations"],
): Promise<Position> {
  const now = new Date().toISOString();
  const position: Position = {
    id: store.newId(),
    userId,
    ...input,
    leverage: input.leverage ?? 1,
    placedAt: now,
    openedAt: now,
    refPrice: input.orderType === "limit" ? marketPrice : undefined,
    status: input.orderType === "limit" ? "pending" : "open",
    proof: { hash: "", status: "pending" },
    alertsSent: [],
    ruleViolations: ruleViolations?.length ? ruleViolations : undefined,
  };
  position.proof.hash = thesisHash(position);
  position.commitment = prepareCommitment(position);
  store.addPosition(position);

  // Public commitment (plaintext hash only) goes up in parallel with the private memory.
  void publishCommitment(position.id, position.commitment);

  // Store asynchronously — the UI polls the proof status while Walrus confirms the blob.
  void remember(userId, "thesis", thesisMemoryText(position), position.id).then((entry) => {
    store.updatePosition(position.id, {
      proof: {
        hash: position.proof.hash,
        status: entry.memory.status,
        blobId: entry.memory.blobId,
        storedAt: entry.memory.status === "stored" ? new Date().toISOString() : undefined,
        error: entry.memory.error,
      },
    });
  });
  return position;
}

export async function checkIn(position: Position, feeling: string, markPrice: number) {
  const m = computeMetrics(position, markPrice);
  const text =
    `[CHECK-IN] ${stamp()} · ${position.symbol} at ${usd(markPrice)} ` +
    `(${m.priceMovePct >= 0 ? "+" : ""}${m.priceMovePct.toFixed(1)}% from entry, PnL ${usd(m.pnl)} / ${m.pnlPct.toFixed(1)}%) ` +
    `on ${describePosition(position)}. User feels: ${feeling.trim().slice(0, 1000)}`;
  return rememberLater(position.userId, "checkin", text, position.id).entry;
}

export async function closePosition(
  position: Position,
  input: { exitPrice: number; reason: string; outcome: Position["thesisOutcome"]; lesson?: string },
) {
  const m = computeMetrics(position, input.exitPrice);
  const held = Math.max(1, Math.round((Date.now() - Date.parse(position.openedAt)) / 86_400_000));
  store.updatePosition(position.id, {
    status: "closed",
    closedAt: new Date().toISOString(),
    exitPrice: input.exitPrice,
    exitReason: input.reason,
    thesisOutcome: input.outcome,
    lesson: input.lesson,
  });
  const text =
    `[OUTCOME] ${stamp()} · Closed ${describePosition(position)} at ${usd(input.exitPrice)} after ${held} day(s). ` +
    `Result: ${m.pnl >= 0 ? "profit" : "loss"} ${usd(m.pnl)} (${m.pnlPct.toFixed(1)}%). ` +
    `Original thesis: "${position.thesis.text.slice(0, 300)}". ` +
    `Thesis verdict: ${input.outcome ?? "unclear"}. Reason for exit: ${input.reason.trim().slice(0, 500)}.` +
    (input.lesson ? ` Lesson learned: ${input.lesson.trim().slice(0, 500)}` : "");
  return rememberLater(position.userId, "close", text, position.id).entry;
}

// ---- limit orders ----

/** A pending limit order's price was reached: it becomes an open position at the limit price. */
export function fillOrder(position: Position, markPrice: number) {
  const filledAt = new Date().toISOString();
  store.updatePosition(position.id, { status: "open", openedAt: filledAt });
  const waited = Math.max(0, Math.round((Date.parse(filledAt) - Date.parse(position.placedAt)) / 3_600_000));
  const text =
    `[FILLED] ${stamp(filledAt)} · Limit order filled: ${describePosition(position)} is now open ` +
    `(market ${usd(markPrice)}, waited ${waited}h since the thesis was written on ${position.placedAt.slice(0, 10)}).`;
  return rememberLater(position.userId, "fill", text, position.id).entry;
}

export function cancelOrder(position: Position, reason: string, markPrice?: number) {
  store.updatePosition(position.id, { status: "cancelled", cancelledAt: new Date().toISOString() });
  const text =
    `[CANCELLED] ${stamp()} · Cancelled limit order ${describePosition(position)} before it filled` +
    (markPrice ? ` (market ${usd(markPrice)})` : "") +
    `. Reason: ${reason.trim().slice(0, 500) || "not specified"}.`;
  return rememberLater(position.userId, "cancel", text, position.id).entry;
}

/** Returns the pending entry plus a promise for the stored one (the bot waits for it, the API does not). */
export function note(userId: string, text: string) {
  return rememberLater(userId, "note", `[NOTE] ${stamp()} · ${text.trim().slice(0, 1500)}`);
}
