import express, { type NextFunction, type Request, type Response } from "express";
import { config, memwalEnabled, walrusNetwork, walruscanBlobUrl } from "./config.js";
import * as coach from "./coach.js";
import * as journal from "./journal.js";
import { llmEnabled } from "./llm.js";
import { memory, memoryFor, recallFor, type RecalledMemory } from "./memory.js";
import { publicView, publishCommitment, walruscanUrl as commitmentWalruscan } from "./commitment.js";
import * as personal from "./personalMemory.js";
import * as postmortem from "./postmortem.js";
import { precheck } from "./precheck.js";
import * as rules from "./rules.js";
import { computeMetrics } from "./positions.js";
import { getQuotes, type Quote } from "./prices.js";
import * as store from "./store.js";
import { verifyInitData } from "./telegramAuth.js";
import type { Position } from "./types.js";

type AuthedRequest = Request & { userId: string };

function auth(req: Request, res: Response, next: NextFunction) {
  const initData = req.header("x-telegram-init-data") ?? "";
  const tgUser = verifyInitData(initData, config.telegram.botToken);
  if (tgUser) {
    store.upsertUser({
      id: String(tgUser.id),
      firstName: tgUser.first_name,
      username: tgUser.username,
      languageCode: tgUser.language_code,
    });
    (req as AuthedRequest).userId = String(tgUser.id);
    return next();
  }
  if (config.isDev && config.devUserId && !initData) {
    store.upsertUser({ id: config.devUserId, firstName: "Dev" });
    (req as AuthedRequest).userId = config.devUserId;
    return next();
  }
  res.status(401).json({ error: "Open this app from Telegram." });
}

const uid = (req: Request) => (req as AuthedRequest).userId;

/** Wraps async handlers so thrown errors become JSON responses. */
const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) =>
    fn(req, res).catch((err: Error) => {
      const status = err instanceof journal.ValidationError || err instanceof personal.PersonalMemoryError ? 400 : 500;
      if (status === 500) console.error(`[api] ${req.method} ${req.path}:`, err);
      res.status(status).json({ error: err.message });
    });

function enrich(p: Position, quotes: Record<string, Quote>) {
  const quote = quotes[p.symbol];
  const mark = p.status === "closed" ? p.exitPrice : quote?.price;
  const waiting = p.status === "pending" || p.status === "cancelled";
  return {
    ...p,
    mark,
    change24hPct: quote?.change24hPct,
    // A limit order has no PnL until it fills; show how far the market is from the limit instead.
    metrics: mark && !waiting ? computeMetrics(p, mark) : null,
    distanceToLimitPct: p.status === "pending" && quote ? ((p.entryPrice - quote.price) / quote.price) * 100 : undefined,
    proofUrl: p.proof.blobId ? walruscanBlobUrl(p.proof.blobId) : undefined,
    commitmentUrl: p.commitment?.blobId ? commitmentWalruscan(p.commitment.blobId) : undefined,
  };
}

/** Adds a Walruscan link to each recalled memory so the UI can show where an answer came from. */
const withProof = (ms: RecalledMemory[]) => ms.map((m) => ({ ...m, proofUrl: m.blobId ? walruscanBlobUrl(m.blobId) : undefined }));

function ownedPosition(req: Request): Position {
  const p = store.getPosition(String(req.params.id));
  if (!p || p.userId !== uid(req)) throw new journal.ValidationError("Position not found");
  return p;
}

export function createApi() {
  const api = express.Router();
  api.use(express.json({ limit: "64kb" }));

  api.get(
    "/health",
    h(async (_req, res) => {
      res.json({ memory: memory.mode, memoryHealth: await memory.health(), llm: llmEnabled, network: walrusNetwork });
    }),
  );

  /** Aggregate counts only — used as proof of usage in the hackathon write-up. */
  api.get("/stats", (_req, res) => {
    const s = store.stats();
    res.json({
      users: s.users,
      totalMemories: s.totalMemories,
      storedOnWalrus: s.storedOnWalrus,
      memoriesPerUser: s.perUser.map((u) => u.memories).sort((a, b) => b - a),
    });
  });

  api.get(
    "/quotes",
    h(async (req, res) => {
      const symbols = String(req.query.symbols ?? "").split(",").filter(Boolean).slice(0, 20);
      res.json(await getQuotes(symbols));
    }),
  );

  /** Public verify page data — no auth, only for theses their owner chose to reveal. */
  api.get("/public/theses/:id", (req, res) => {
    const p = store.getPosition(String(req.params.id));
    const view = p && publicView(p);
    if (!view) return res.status(404).json({ error: "This thesis is private or does not exist." });
    res.json(view);
  });

  api.use(auth);

  api.get("/me", (req, res) => {
    // Never echo the stored (encrypted) delegate key back to the client.
    const { memwal, ...user } = store.getUser(uid(req)) ?? ({} as NonNullable<ReturnType<typeof store.getUser>>);
    const target = memoryFor(uid(req));
    res.json({
      user,
      namespace: target.namespace,
      memorySpace: target.space,
      memoryMode: target.backend.mode,
      walrus: memwalEnabled || Boolean(memwal),
      network: walrusNetwork,
    });
  });

  // ---- optional: the user's own Walrus Memory account ----

  api.get("/memory/account", (req, res) => res.json(personal.status(uid(req))));

  api.post(
    "/memory/account",
    h(async (req, res) => {
      const { privateKey, accountId } = req.body ?? {};
      res.json(await personal.connect(uid(req), String(privateKey ?? ""), String(accountId ?? "")));
    }),
  );

  api.post("/memory/account/disconnect", (req, res) => res.json(personal.disconnect(uid(req))));

  api.post(
    "/memory/import",
    h(async (req, res) => {
      res.json(personal.startImport(uid(req)));
    }),
  );

  api.get(
    "/portfolio",
    h(async (req, res) => {
      const positions = store.positionsFor(uid(req));
      const quotes = await getQuotes(positions.filter((p) => p.status === "open" || p.status === "pending").map((p) => p.symbol));
      const enriched = positions.map((p) => enrich(p, quotes));
      const open = enriched.filter((p) => p.status === "open" && p.metrics);
      const closed = enriched.filter((p) => p.status === "closed" && p.metrics);

      const invested = open.reduce((a, p) => a + p.metrics!.invested, 0);
      const value = open.reduce((a, p) => a + p.metrics!.value, 0);
      const unrealized = open.reduce((a, p) => a + p.metrics!.pnl, 0);
      const realized = closed.reduce((a, p) => a + p.metrics!.pnl, 0);

      // Realized PnL per month for the last 6 months (bar chart on the home screen).
      const months: Array<{ month: string; profit: number; loss: number }> = [];
      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        months.push({ month: d.toISOString().slice(0, 7), profit: 0, loss: 0 });
      }
      for (const p of closed) {
        const bucket = months.find((m) => p.closedAt?.startsWith(m.month));
        if (!bucket) continue;
        if (p.metrics!.pnl >= 0) bucket.profit += p.metrics!.pnl;
        else bucket.loss += -p.metrics!.pnl;
      }

      const memories = store.journalFor(uid(req));
      res.json({
        invested,
        value,
        unrealized,
        unrealizedPct: invested ? (unrealized / invested) * 100 : 0,
        realized,
        openCount: open.length,
        pendingCount: enriched.filter((p) => p.status === "pending").length,
        closedCount: closed.length,
        months,
        memoryCount: memories.length,
        storedOnWalrus: memories.filter((m) => m.memory.status === "stored").length,
        positions: enriched,
      });
    }),
  );

  api.get(
    "/positions/:id",
    h(async (req, res) => {
      const p = ownedPosition(req);
      const quotes = await getQuotes([p.symbol]);
      res.json({
        position: enrich(p, quotes),
        journal: store.journalFor(uid(req), p.id).map((j) => ({
          ...j,
          proofUrl: j.memory.blobId ? walruscanBlobUrl(j.memory.blobId) : undefined,
        })),
      });
    }),
  );

  api.post(
    "/positions",
    h(async (req, res) => {
      const input = journal.validatePositionInput(req.body);
      const market = (await getQuotes([input.symbol]))[input.symbol]?.price;
      if (input.orderType === "limit" && !market) {
        throw new journal.ValidationError(`No live price for ${input.symbol}, so a limit order could never fill`);
      }
      // Opening a position that breaks the user's own rules is allowed — but it's remembered.
      const violations = rules.evaluateRules(store.rulesFor(uid(req)), input);
      const p = await journal.openPosition(uid(req), input, market, violations);
      res.status(201).json({ position: p });
    }),
  );

  api.post(
    "/positions/:id/checkin",
    h(async (req, res) => {
      const p = ownedPosition(req);
      const feeling = String(req.body?.feeling ?? "").trim();
      if (feeling.length < 3) throw new journal.ValidationError("Tell me how you feel about this position.");
      const mark = (await getQuotes([p.symbol]))[p.symbol]?.price ?? p.entryPrice;
      const entry = await journal.checkIn(p, feeling, mark);
      // The coach immediately answers the check-in with the user's own past context.
      // The position goes in as context, not as an English prefix, so the reply stays in the user's language.
      const { reply, memoriesUsed, drift } = await coach.chat(uid(req), feeling, { position: p });
      res.json({ entry, reply, memoriesUsed: withProof(memoriesUsed), drift });
    }),
  );

  /** "Before you enter": what does the user's memory say about this trade? Accepts a half-filled form. */
  api.post(
    "/positions/precheck",
    h(async (req, res) => {
      const input = journal.parsePositionInput(req.body);
      if (!input.symbol) throw new journal.ValidationError("symbol is required");
      const candidate = {
        ...input,
        entryPrice: input.entryPrice > 0 ? input.entryPrice : ((await getQuotes([input.symbol]))[input.symbol]?.price ?? 0),
        size: input.size > 0 ? input.size : 0,
      };
      res.json(await precheck(uid(req), { ...candidate, thesisText: input.thesis.text }, req.body?.explain !== false));
    }),
  );

  /** Retry publishing a public commitment that failed (e.g. the testnet publisher was down). */
  api.post(
    "/positions/:id/commit",
    h(async (req, res) => {
      const p = ownedPosition(req);
      if (!p.commitment || p.commitment.status !== "failed") throw new journal.ValidationError("Nothing to retry");
      store.updatePosition(p.id, { commitment: { ...p.commitment, status: "pending", error: undefined } });
      void publishCommitment(p.id, p.commitment);
      res.json({ position: store.getPosition(p.id) });
    }),
  );

  api.post(
    "/positions/:id/reveal",
    h(async (req, res) => {
      const p = ownedPosition(req);
      const reveal = req.body?.reveal !== false;
      if (reveal && p.commitment?.status !== "published") {
        throw new journal.ValidationError("The public commitment for this thesis isn't on Walrus yet.");
      }
      store.updatePosition(p.id, { revealed: reveal, revealedAt: reveal ? new Date().toISOString() : undefined });
      res.json({ position: store.getPosition(p.id) });
    }),
  );

  /** Suggested story + lesson for a position about to be closed, built from its memories. Nothing is stored. */
  api.post(
    "/positions/:id/review",
    h(async (req, res) => {
      const p = ownedPosition(req);
      if (p.status !== "open") throw new journal.ValidationError("Only open positions can be reviewed before closing");
      const exitPrice = Number(req.body?.exitPrice) || (await getQuotes([p.symbol]))[p.symbol]?.price;
      if (!exitPrice) throw new journal.ValidationError("Could not determine exit price");
      res.json(await postmortem.draft(p, exitPrice));
    }),
  );

  api.post(
    "/positions/:id/cancel",
    h(async (req, res) => {
      const p = ownedPosition(req);
      if (p.status !== "pending") throw new journal.ValidationError("Only pending limit orders can be cancelled");
      const mark = (await getQuotes([p.symbol]))[p.symbol]?.price;
      const entry = journal.cancelOrder(p, String(req.body?.reason ?? ""), mark);
      res.json({ position: store.getPosition(p.id), entry });
    }),
  );

  api.post(
    "/positions/:id/close",
    h(async (req, res) => {
      const p = ownedPosition(req);
      if (p.status !== "open") throw new journal.ValidationError("Only open positions can be closed");
      const body = req.body ?? {};
      const exitPrice = Number(body.exitPrice) || (await getQuotes([p.symbol]))[p.symbol]?.price;
      if (!exitPrice) throw new journal.ValidationError("Could not determine exit price");
      const outcome = ["right", "wrong", "partial", "unclear"].includes(body.outcome) ? body.outcome : "unclear";
      const reason = String(body.reason ?? "").trim() || "not specified";
      const lesson = body.lesson ? String(body.lesson) : undefined;
      const entry = await journal.closePosition(p, { exitPrice, reason, outcome, lesson });
      if (lesson) void rules.extractRules(uid(req), `Lesson: ${lesson}\nWhy I closed: ${reason}`, "lesson");
      void postmortem.writePostMortem(p.id);
      res.json({ position: store.getPosition(p.id), entry });
    }),
  );

  api.get("/journal", (req, res) => {
    res.json(
      store.journalFor(uid(req)).map((j) => ({
        ...j,
        proofUrl: j.memory.blobId ? walruscanBlobUrl(j.memory.blobId) : undefined,
      })),
    );
  });

  api.post(
    "/journal",
    h(async (req, res) => {
      const text = String(req.body?.text ?? "").trim();
      if (text.length < 3) throw new journal.ValidationError("Note is empty");
      void rules.extractRules(uid(req), text, "note");
      res.status(201).json(journal.note(uid(req), text).entry);
    }),
  );

  api.get(
    "/recall",
    h(async (req, res) => {
      const q = String(req.query.q ?? "").trim();
      if (!q) throw new journal.ValidationError("q is required");
      const results = await recallFor(uid(req), q, 10);
      res.json(withProof(results));
    }),
  );

  // ---- personal trading rules ----

  api.get("/rules", (req, res) => res.json(store.rulesFor(uid(req))));

  api.post(
    "/rules",
    h(async (req, res) => {
      const text = String(req.body?.text ?? "").trim();
      if (text.length < 5) throw new journal.ValidationError("Write the rule in a few words");
      res.status(201).json(await rules.addManualRule(uid(req), text));
    }),
  );

  api.post("/rules/:id/delete", (req, res) => {
    const removed = rules.deleteRule(uid(req), String(req.params.id));
    if (!removed) return res.status(404).json({ error: "Rule not found" });
    res.json({ ok: true });
  });

  api.get("/chat", (req, res) => res.json(store.chatHistory(uid(req))));

  api.post(
    "/chat",
    h(async (req, res) => {
      const message = String(req.body?.message ?? "").trim().slice(0, 2000);
      if (!message) throw new journal.ValidationError("message is required");
      const out = await coach.chat(uid(req), message);
      res.json({ ...out, memoriesUsed: withProof(out.memoriesUsed) });
    }),
  );

  api.get(
    "/insights",
    h(async (req, res) => {
      res.json(await coach.insights(uid(req), req.query.force === "1"));
    }),
  );

  /** Track record: every thesis with its Walrus proof. */
  api.get("/proof", (req, res) => {
    const positions = store.positionsFor(uid(req));
    res.json(
      positions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        type: p.type,
        side: p.side,
        leverage: p.leverage,
        entryPrice: p.entryPrice,
        exitPrice: p.exitPrice,
        status: p.status,
        openedAt: p.openedAt,
        placedAt: p.placedAt,
        orderType: p.orderType,
        closedAt: p.closedAt,
        thesis: p.thesis,
        thesisOutcome: p.thesisOutcome,
        pnlPct: p.exitPrice ? computeMetrics(p, p.exitPrice).pnlPct : undefined,
        proof: p.proof,
        proofUrl: p.proof.blobId ? walruscanBlobUrl(p.proof.blobId) : undefined,
        commitment: p.commitment ? { hash: p.commitment.hash, status: p.commitment.status, network: p.commitment.network } : undefined,
        commitmentUrl: p.commitment?.blobId ? commitmentWalruscan(p.commitment.blobId) : undefined,
        revealed: Boolean(p.revealed),
      })),
    );
  });

  return api;
}
