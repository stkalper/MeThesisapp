import { useEffect, useMemo, useState } from "react";
import { api, type Position } from "../api";
import { Icon, LiveValue, MemoryBadge, PnlChip, Ring, Spinner, toast, TopBar, useLive, useLoad } from "../components";
import { ago, date, parseNum, pct, price, qty, shortHash, simulate, time, usd } from "../format";
import { haptic, openLink, shareText } from "../telegram";

/** 0 = at invalidation (or liquidation), 1 = at target. */
function thesisProgress(p: Position, mark: number): number {
  const up = p.side === "long";
  const floor = p.thesis.invalidationPrice ?? p.metrics?.liquidationPrice ?? p.entryPrice * (up ? 0.5 : 1.5);
  const ceil = p.thesis.targetPrice ?? p.entryPrice * (up ? 1.5 : 0.5);
  if (floor === ceil) return 0.5;
  return (mark - floor) / (ceil - floor);
}

function Simulator({ p }: { p: Position }) {
  const mark = p.mark ?? p.entryPrice;
  const levels = [p.thesis.invalidationPrice, p.thesis.targetPrice, p.metrics?.liquidationPrice, p.entryPrice, mark].filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  const min = Math.min(...levels) * 0.9;
  const max = Math.max(...levels) * 1.1;
  const [sim, setSim] = useState(mark);
  // Follow the live price until the user grabs the slider; "Reset" hands it back to the market.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setSim(mark);
  }, [mark, touched]);
  const r = simulate(p, sim);
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  const markers = [
    { v: p.entryPrice, label: "Entry" },
    p.thesis.targetPrice && { v: p.thesis.targetPrice, label: "Target" },
    p.thesis.invalidationPrice && { v: p.thesis.invalidationPrice, label: "Invalid." },
    p.metrics?.liquidationPrice && { v: p.metrics.liquidationPrice, label: "Liq." },
  ]
    .filter((m): m is { v: number; label: string } => Boolean(m))
    .sort((a, b) => a.v - b.v)
    // Drop labels that would sit on top of the previous one.
    .filter((m, i, all) => i === 0 || (m.v - all[i - 1]!.v) / (max - min) > 0.12);

  return (
    <section className="card">
      <div className="card-title">
        What-if simulator
        <button onClick={() => { setTouched(false); setSim(mark); }}>{touched ? "Back to market" : "Live"}</button>
      </div>
      <div className="sim-price">
        <span className="eyebrow">If {p.symbol} goes to</span>
        <b><LiveValue value={touched ? undefined : sim}>{price(sim)}</LiveValue></b>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={(max - min) / 400}
        value={sim}
        onChange={(e) => { setTouched(true); setSim(Number(e.target.value)); }}
        aria-label="Simulated price"
      />
      <div className="sim-scale">
        {markers.map((m) => <span key={m.label} style={{ left: pos(m.v) }}>{m.label}</span>)}
      </div>
      <div className="sim-result">
        <div>
          <span>PnL</span>
          <b className={r.pnl >= 0 ? "up" : "down"}>{usd(r.pnl, { sign: true })}</b>
        </div>
        <div>
          <span>{p.type === "perp" ? "ROE" : "Return"}</span>
          <b className={r.pnl >= 0 ? "up" : "down"}>{r.liquidated ? "LIQUIDATED" : pct(r.pnlPct, 1)}</b>
        </div>
      </div>
    </section>
  );
}

/** The post-mortem is written right after close; older trades (before the feature) never get one. */
const awaitingStory = (p: Position) =>
  p.status === "closed" && !p.postmortem && !!p.closedAt && Date.now() - Date.parse(p.closedAt) < 3 * 60_000;

function TradeStory({ p, onRule }: { p: Position; onRule: () => void }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const pm = p.postmortem;
  const PLAN = { yes: "Followed the plan", partly: "Partly followed the plan", no: "Broke the plan", unclear: "Plan unclear" } as const;

  async function makeRule() {
    if (!pm?.lesson) return;
    setSaving(true);
    try {
      await api.addRule(pm.lesson);
      setSaved(true);
      haptic.success();
      toast("Added to your rules — future positions are checked against it");
      onRule();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card mt">
      <div className="card-title">
        <span className="row"><Icon.brain /> Trade story</span>
        {pm && <span className={`badge ${pm.followedPlan === "yes" ? "stored" : pm.followedPlan === "no" ? "failed" : "local"}`}>{PLAN[pm.followedPlan]}</span>}
      </div>
      {pm ? (
        <>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{pm.story}</p>
          {pm.lesson && (
            <div className="lesson">
              <span className="hint">Lesson</span>
              <b>{pm.lesson}</b>
              <button className="chip" disabled={saving || saved} onClick={() => void makeRule()}>
                {saved ? "✓ Added to my rules" : saving ? <Spinner /> : "Make this a rule"}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="eyebrow"><Spinner /> Writing the story of this trade from its memories…</p>
      )}
    </section>
  );
}

function CloseSheet({ p, onDone, onCancel }: { p: Position; onDone: () => void; onCancel: () => void }) {
  const [exit, setExit] = useState(String(p.mark ?? ""));
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState("partial");
  const [lesson, setLesson] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [story, setStory] = useState<string>();
  const exitN = parseNum(exit);
  const r = exitN > 0 ? simulate(p, exitN) : null;

  async function suggest() {
    setSuggesting(true);
    try {
      const d = await api.review(p.id, exitN > 0 ? exitN : undefined);
      setStory(d.story);
      if (d.lesson) setLesson(d.lesson);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setSuggesting(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await api.close(p.id, { exitPrice: exitN > 0 ? exitN : undefined, reason, outcome, lesson: lesson || undefined });
      haptic.success();
      toast("Closed. The outcome and lesson are now part of your memory.");
      onDone();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3>Close {p.symbol}</h3><span className="spacer" /><button onClick={onCancel} aria-label="Close"><Icon.x /></button></div>
        <div className="form">
          <div className="field">
            <label>Exit price {r ? `· ${usd(r.pnl, { sign: true })} (${pct(r.pnlPct, 1)})` : ""}</label>
            <input className="input" inputMode="decimal" value={exit} onChange={(e) => setExit(e.target.value)} />
          </div>
          <div className="field">
            <label>Did your thesis play out?</label>
            <div className="pick">
              {[["right", "Yes"], ["partial", "Partly"], ["wrong", "No, I was wrong"], ["unclear", "Too early to tell"]].map(([v, l]) => (
                <button key={v} className={outcome === v ? "on" : ""} onClick={() => setOutcome(v)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Why are you closing now?</label>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Target hit / invalidation hit / I got scared / need liquidity…" />
          </div>
          <div className="field">
            <label>Lesson for future you</label>
            <textarea className="textarea" value={lesson} onChange={(e) => setLesson(e.target.value)} placeholder="One sentence you'd want to read before the next trade" />
            <button className="chip" style={{ justifySelf: "start" }} disabled={suggesting} onClick={() => void suggest()}>
              {suggesting ? <Spinner /> : <Icon.brain />} {suggesting ? "Reading this trade's memories…" : "Suggest a lesson from my memory"}
            </button>
            {story && <p className="hint" style={{ lineHeight: 1.5 }}>{story}</p>}
          </div>
          <button className="btn primary" disabled={busy || reason.trim().length < 3} onClick={submit}>
            {busy ? <Spinner /> : null} Close & remember
          </button>
        </div>
      </div>
    </div>
  );
}

export function PositionDetail({ id }: { id: string }) {
  const { data, loading, error, reload } = useLoad(() => api.position(id), [id]);
  const [feeling, setFeeling] = useState("");
  const [checking, setChecking] = useState(false);
  const [coachReply, setCoachReply] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState(false);

  // Poll while Walrus is confirming the thesis blob or any journal entry.
  const pending =
    data &&
    (data.position.proof.status === "pending" ||
      awaitingStory(data.position) ||
      data.position.commitment?.status === "pending" ||
      data.journal.some((j) => j.memory.status === "pending"));
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(t);
  }, [pending, reload]);

  // Live price + PnL while the position (or limit order) is active; a waiting order also flips to "open" here.
  const active = data?.position.status === "open" || data?.position.status === "pending";
  useLive(reload, active);

  const p = data?.position;
  const progress = useMemo(() => (p && p.mark ? thesisProgress(p, p.mark) : 0.5), [p]);

  if (loading && !data) return <><TopBar title="Position" back="" /><div className="skeleton" /></>;
  if (error || !p) return <><TopBar title="Position" back="" /><div className="banner">{error ?? "Not found"}</div></>;

  const m = p.metrics;
  const closed = p.status === "closed";
  const waiting = p.status === "pending";
  const cancelled = p.status === "cancelled";
  const done = closed || cancelled;
  const gap = p.distanceToLimitPct;

  const verifyUrl = `${window.location.origin}${window.location.pathname}#/verify/${p.id}`;

  async function setRevealed(reveal: boolean) {
    try {
      await api.reveal(p!.id, reveal);
      setConfirmReveal(false);
      haptic.success();
      toast(reveal ? "Thesis is public — anyone with the link can verify it" : "Thesis is private again");
      void reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  async function cancelOrder() {
    try {
      await api.cancel(p!.id);
      haptic.success();
      toast("Order cancelled — noted in your memory");
      setConfirmCancel(false);
      void reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  async function sendCheckIn() {
    setChecking(true);
    setCoachReply(undefined);
    try {
      const res = await api.checkIn(p!.id, feeling);
      setFeeling("");
      setCoachReply(res.reply);
      haptic.success();
      void reload();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setChecking(false);
    }
  }

  const proofStatus = p.proof.status;

  return (
    <div className="fade-in">
      <TopBar title={`${p.symbol} ${p.type === "perp" ? `${p.leverage}x ${p.side}` : "spot"}`} back="" />

      {waiting || cancelled ? (
        <Ring
          // How close the market is to the limit: full ring = at the limit price.
          progress={cancelled ? 0 : gap === undefined ? 0.5 : 1 - Math.min(1, Math.abs(gap) / 10)}
          center={cancelled ? "Cancelled" : `@ ${price(p.entryPrice)}`}
          caption={cancelled ? `Limit was ${price(p.entryPrice)}` : `Market ${price(p.mark)}${gap !== undefined ? ` · ${pct(gap, 1)} away` : ""}`}
          doneLabel="Waiting"
          restLabel={`Limit ${price(p.entryPrice)}`}
        />
      ) : (
        <Ring
          progress={progress}
          center={<LiveValue value={m?.pnl}>{m ? usd(m.pnl, { sign: true }) : "—"}</LiveValue>}
          caption={closed ? `Closed at ${price(p.exitPrice)}` : <><span className="live-dot" />{p.symbol} <LiveValue value={p.mark}>{price(p.mark)}</LiveValue></>}
          doneLabel={closed ? "Realized" : `Entry ${price(p.entryPrice)}`}
          restLabel={p.thesis.targetPrice ? `Target ${price(p.thesis.targetPrice)}` : "No target set"}
        />
      )}
      <div className="chips" style={{ justifyContent: "center", marginTop: -6 }}>
        {m && <span className="chip light">{pct(m.pnlPct, 1)} {p.type === "perp" ? "ROE" : "return"}</span>}
        {m?.liquidationPrice && !done && <span className="chip light">Liq. {price(m.liquidationPrice)}</span>}
        {waiting && <span className="chip light">⏳ Limit order</span>}
        {p.change24hPct !== undefined && !done && <span className="chip light">24h {pct(p.change24hPct, 1)}</span>}
      </div>

      <div className="tab-card">
        <div className="tab-card-head">
          <div className="tab-card-label">Thesis</div>
          <div className="tab-card-meta">
            <span><Icon.clock />{time(p.placedAt)}</span>
            <span><Icon.calendar />{date(p.placedAt)}</span>
          </div>
        </div>
        <div className="tab-card-body">
          <p className="quote">“{p.thesis.text}”</p>
          <div className="kv">
            <div><span>Target</span><b>{price(p.thesis.targetPrice)}</b></div>
            <div><span>Invalidation</span><b>{price(p.thesis.invalidationPrice)}</b></div>
            <div><span>Horizon</span><b>{p.thesis.horizon ?? "—"}</b></div>
            <div><span>Conviction</span><b>{"●".repeat(p.thesis.conviction)}{"○".repeat(5 - p.thesis.conviction)}</b></div>
          </div>
          {p.thesis.invalidationText && <p className="small" style={{ marginTop: 12 }}>Also wrong if: {p.thesis.invalidationText}</p>}
          <div className="tab-card-foot">
            <span className="row">
              <span className={`badge ${proofStatus}`}>
                {proofStatus === "pending" ? <span className="spin" style={{ width: 10, height: 10 }} /> : null}
                {{ stored: "Sealed on Walrus", pending: "Sealing…", failed: "Seal failed", local: "Local only" }[proofStatus]}
              </span>
              <span className="hash">sha256 {shortHash(p.proof.hash)}</span>
            </span>
            {p.proofUrl && <button className="link-btn" onClick={() => openLink(p.proofUrl!)}>Private blob ↗</button>}
          </div>
          {p.commitment && (
            <div className="public-proof">
              <div className="row">
                <b>Public proof</b>
                <span className="spacer" />
                {p.commitment.status === "pending" && <span className="badge pending"><span className="spin" style={{ width: 10, height: 10 }} />Committing…</span>}
                {p.commitment.status === "failed" && <span className="badge failed">Commit failed</span>}
                {p.commitment.status === "published" && (
                  <span className={`badge ${p.revealed ? "stored" : "local"}`}>{p.revealed ? "Revealed" : "Hash committed"}</span>
                )}
              </div>
              <p className="small" style={{ margin: "6px 0 10px" }}>
                {p.commitment.status === "failed"
                  ? "Couldn't publish the public commitment to Walrus. Your private thesis is unaffected."
                  : p.commitment.status === "pending"
                    ? `Publishing the sha256 of this thesis to Walrus ${p.commitment.network}…`
                    : p.revealed
                      ? "Anyone with the link can check this thesis against its public commitment on Walrus."
                      : `Only the sha256 is public on Walrus ${p.commitment.network}. Reveal to let anyone verify you wrote this before the move.`}
              </p>
              {p.commitment.status === "failed" && (
                <button
                  className="chip"
                  onClick={async () => {
                    try {
                      await api.retryCommit(p.id);
                      void reload();
                    } catch (err) {
                      toast((err as Error).message, true);
                    }
                  }}
                >
                  Retry
                </button>
              )}
              {p.commitment.status === "published" && (
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {p.revealed ? (
                    <>
                      <button
                        className="chip"
                        onClick={() =>
                          shareText(`My ${p.side.toUpperCase()} ${p.symbol} thesis, committed on Walrus on ${date(p.placedAt)} — verify it:`, verifyUrl)
                        }
                      >
                        <Icon.share /> Share proof
                      </button>
                      <button className="chip" onClick={() => openLink(verifyUrl)}>Open page ↗</button>
                      <button className="chip" onClick={() => void setRevealed(false)}>Make private</button>
                    </>
                  ) : (
                    <button className="chip" onClick={() => (confirmReveal ? void setRevealed(true) : setConfirmReveal(true))}>
                      {confirmReveal ? "Thesis text becomes public — tap to confirm" : "Reveal publicly"}
                    </button>
                  )}
                  {p.commitmentUrl && <button className="link-btn" onClick={() => openLink(p.commitmentUrl!)}>Commitment ↗</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tab-card navy">
        <div className="tab-card-head">
          <div className="tab-card-label">{waiting || cancelled ? "Order" : "Position"}</div>
          <div className="tab-card-meta">
            {closed
              ? `closed ${ago(p.closedAt!)}`
              : cancelled
                ? `cancelled ${ago(p.cancelledAt!)}`
                : waiting
                  ? `placed ${ago(p.placedAt)}`
                  : p.orderType === "limit"
                    ? `filled ${ago(p.openedAt)}`
                    : `opened ${ago(p.openedAt)}`}
          </div>
        </div>
        <div className="tab-card-body">
          <div className="tab-card-title">
            {waiting ? "LIMIT " : ""}{p.side.toUpperCase()} {p.symbol} {p.type === "perp" ? `· ${p.leverage}x perp` : "· spot"}
          </div>
          {m && <div className="chips"><PnlChip percent={m.pnlPct} /><span className="chip">{usd(m.pnl, { sign: true })}</span></div>}
          <div className="tab-card-foot">
            <span>{waiting || cancelled ? "Limit" : "Entry"}: {price(p.entryPrice)}</span>
            <span>{p.type === "perp" ? `Margin: ${usd(p.size)}` : `Qty: ${qty(p.size)} ${p.symbol}`}</span>
            <span>
              {p.type === "perp"
                ? `Size: ${qty((p.size * p.leverage) / p.entryPrice)} ${p.symbol} · ${usd(p.size * p.leverage)}`
                : `Cost: ${usd(p.size * p.entryPrice)}`}
            </span>
          </div>
          {closed && p.lesson && <p className="small" style={{ marginTop: 10 }}>Lesson: {p.lesson}</p>}
        </div>
      </div>

      {closed && (p.postmortem || awaitingStory(p)) && <TradeStory p={p} onRule={() => void reload()} />}

      {!done && <div className="mt"><Simulator p={p} /></div>}

      {!done && (
        <section className="card">
          <div className="card-title">How do you feel about it?</div>
          <div className="form">
            <textarea
              className="textarea"
              value={feeling}
              onChange={(e) => setFeeling(e.target.value)}
              placeholder="e.g. Scary headlines, I want to close everything…"
            />
            <div className="btn-row">
              <button className="btn primary" disabled={checking || feeling.trim().length < 3} onClick={sendCheckIn}>
                {checking ? <Spinner /> : null} Check in
              </button>
              {waiting ? (
                <button className="btn ghost" onClick={() => (confirmCancel ? void cancelOrder() : setConfirmCancel(true))}>
                  {confirmCancel ? "Tap to confirm" : "Cancel order"}
                </button>
              ) : (
                <button className="btn ghost" onClick={() => setClosing(true)}>Close position</button>
              )}
            </div>
            {coachReply && <div className="bubble assistant fade-in" style={{ maxWidth: "100%", color: "var(--ink)" }}>{coachReply}</div>}
          </div>
        </section>
      )}

      <div className="section">
        <h2>Memory for this position</h2>
        <div className="timeline">
          {data!.journal.map((j) => (
            <div className="mem" key={j.id}>
              <div className="mem-head"><span className="mem-kind">{j.kind}</span><span>{ago(j.createdAt)}</span></div>
              <div className="mem-text">{j.text.replace(/^\[[A-Z-]+\]\s*/, "")}</div>
              <div className="mem-foot"><MemoryBadge entry={j} /></div>
            </div>
          ))}
        </div>
      </div>

      {closing && <CloseSheet p={p} onCancel={() => setClosing(false)} onDone={() => { setClosing(false); void reload(); }} />}
    </div>
  );
}
