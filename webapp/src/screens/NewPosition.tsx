import { useEffect, useMemo, useState } from "react";
import { api, type OrderType, type PositionType, type Side, type SizeUnit } from "../api";
import { go, Spinner, toast, TopBar } from "../components";
import { canonicalSize, parseNum, pct, price, qty, simulate, usd } from "../format";
import { haptic } from "../telegram";
import { MemoryCheck } from "./MemoryCheck";

const SYMBOLS = ["BTC", "ETH", "SOL", "SUI", "WAL", "DEEP"];
const HORIZONS = ["1 week", "1 month", "3 months", "6 months", "1 year+"];
const PROMPTS = [
  "What does the market not see yet?",
  "What catalyst do you expect, and when?",
  "Why now and not a month ago?",
];

export function NewPosition() {
  const [type, setType] = useState<PositionType>("perp");
  const [side, setSide] = useState<Side>("long");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>("margin");
  const [symbol, setSymbol] = useState("BTC");
  const [market, setMarket] = useState<number | undefined>();
  const [entry, setEntry] = useState("");
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [thesis, setThesis] = useState("");
  const [target, setTarget] = useState("");
  const [invalidation, setInvalidation] = useState("");
  const [invalidationText, setInvalidationText] = useState("");
  const [horizon, setHorizon] = useState("1 month");
  const [conviction, setConviction] = useState(3);
  const [saving, setSaving] = useState(false);
  const [entryTouched, setEntryTouched] = useState(false);

  useEffect(() => {
    const s = symbol.trim().toUpperCase();
    if (s.length < 2) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const q = (await api.quotes([s]))[s];
        if (cancelled) return;
        setMarket(q?.price);
        if (q && !entryTouched) setEntry(String(q.price));
      } catch {
        if (!cancelled) setMarket(undefined);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [symbol, entryTouched]);

  // "Margin" only makes sense for perps.
  useEffect(() => {
    if (type === "spot" && sizeUnit === "margin") setSizeUnit("usdt");
  }, [type, sizeUnit]);

  const effectiveSide: Side = type === "spot" ? "long" : side;
  const lev = type === "perp" ? leverage : 1;
  const entryN = parseNum(entry), sizeValue = parseNum(size), targetN = parseNum(target), invalidationN = parseNum(invalidation);
  /** Canonical size the server stores: spot → coins, perp → margin. */
  const sizeN = canonicalSize(type, sizeUnit, sizeValue, entryN, lev);
  const coins = sizeN > 0 ? (type === "spot" ? sizeN : (sizeN * lev) / entryN) : NaN;
  const units: Array<[SizeUnit, string]> =
    type === "perp" ? [["margin", "Margin USDT"], ["usdt", "Size USDT"], ["token", symbol || "Coins"]] : [["usdt", "USDT"], ["token", symbol || "Coins"]];
  const limitGap = orderType === "limit" && market && entryN > 0 ? ((entryN - market) / market) * 100 : undefined;

  const sim = useMemo(() => {
    if (!(entryN > 0 && sizeN > 0)) return null;
    const base = { type, side: effectiveSide, entryPrice: entryN, size: sizeN, leverage: type === "perp" ? leverage : 1 };
    const at = (p: number) => (p > 0 ? simulate(base, p) : null);
    return { now: simulate(base, market ?? entryN), target: at(targetN), invalidation: at(invalidationN), liq: simulate(base, entryN).liq, base };
  }, [entryN, sizeN, type, effectiveSide, leverage, targetN, invalidationN, market]);

  // Warn when the invalidation sits beyond the liquidation price — the thesis can't even be tested.
  const liqBeforeInvalidation =
    sim?.liq && invalidationN > 0 &&
    (effectiveSide === "long" ? sim.liq >= invalidationN : sim.liq <= invalidationN);

  // Field → problem. Shown after the first submit attempt instead of silently disabling the button.
  const problems: Record<string, string> = {};
  if (symbol.trim().length < 2) problems.symbol = "Choose an asset";
  if (!(entryN > 0)) problems.entry = orderType === "limit" ? "Enter the limit price" : "Enter the entry price";
  if (!(sizeValue > 0)) problems.size = "Enter the position size";
  if (thesis.trim().length < 10) problems.thesis = "Write your thesis (at least 10 characters)";
  if (target.trim() && !(targetN > 0)) problems.target = "Target must be a number";
  if (invalidation.trim() && !(invalidationN > 0)) problems.invalidation = "Invalidation must be a number";
  const long = effectiveSide === "long";
  if (entryN > 0 && targetN > 0 && (long ? targetN <= entryN : targetN >= entryN))
    problems.target = `For a ${effectiveSide}, the target must be ${long ? "above" : "below"} the entry price`;
  if (entryN > 0 && invalidationN > 0 && (long ? invalidationN >= entryN : invalidationN <= entryN))
    problems.invalidation = `For a ${effectiveSide}, the invalidation must be ${long ? "below" : "above"} the entry price`;
  const [attempted, setAttempted] = useState(false);
  const [brokenRules, setBrokenRules] = useState(0);

  // What the "Memory check" card evaluates — re-sent (debounced) whenever the form changes.
  const checkForm = useMemo(
    () =>
      symbol.trim().length >= 2
        ? {
            type,
            side: effectiveSide,
            symbol,
            orderType,
            leverage: lev,
            entryPrice: entryN > 0 ? entryN : undefined,
            sizeInput: sizeValue > 0 ? { unit: sizeUnit, value: sizeValue } : undefined,
            thesis: {
              text: thesis.trim(),
              targetPrice: targetN > 0 ? targetN : undefined,
              invalidationPrice: invalidationN > 0 ? invalidationN : undefined,
              invalidationText: invalidationText.trim() || undefined,
            },
          }
        : null,
    [type, effectiveSide, symbol, orderType, lev, entryN, sizeValue, sizeUnit, thesis, targetN, invalidationN, invalidationText],
  );
  const bad = (field: string) => (attempted && problems[field] ? " invalid" : "");

  async function submit() {
    const first = Object.values(problems)[0];
    if (first) {
      setAttempted(true);
      toast(first, true);
      return;
    }
    setSaving(true);
    try {
      const { position } = await api.createPosition({
        type,
        side: effectiveSide,
        symbol,
        entryPrice: entryN,
        sizeInput: { unit: sizeUnit, value: sizeValue },
        orderType,
        leverage,
        thesis: {
          text: thesis,
          targetPrice: targetN > 0 ? targetN : undefined,
          invalidationPrice: invalidationN > 0 ? invalidationN : undefined,
          invalidationText: invalidationText || undefined,
          horizon,
          conviction,
        },
      });
      haptic.success();
      toast(orderType === "limit" ? "Order placed — I'll ping you when it fills" : "Thesis written — sealing it on Walrus…");
      go(`/position/${position.id}`);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fade-in">
      <TopBar title="New thesis" back="" />

      <section className="card">
        <div className="form">
          <div className="segmented">
            <button className={type === "spot" ? "on" : ""} onClick={() => setType("spot")}>Spot</button>
            <button className={type === "perp" ? "on" : ""} onClick={() => setType("perp")}>Perp</button>
          </div>

          {type === "perp" && (
            <div className="segmented">
              <button className={`${side === "long" ? "on long" : ""}`} onClick={() => setSide("long")}>Long</button>
              <button className={`${side === "short" ? "on short" : ""}`} onClick={() => setSide("short")}>Short</button>
            </div>
          )}

          <div className="field">
            <label>Asset</label>
            <div className="pick">
              {SYMBOLS.map((s) => (
                <button key={s} className={symbol === s ? "on" : ""} onClick={() => { setSymbol(s); setEntryTouched(false); }}>{s}</button>
              ))}
            </div>
            <input className={`input${bad("symbol")}`} value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setEntryTouched(false); }} placeholder="Ticker, e.g. BTC" />
            <span className="hint">{market ? `Market: ${price(market)}` : symbol.length >= 2 ? "Price not found — enter entry manually" : ""}</span>
          </div>

          <div className="field">
            <label>Order</label>
            <div className="segmented">
              <button className={orderType === "market" ? "on" : ""} onClick={() => setOrderType("market")}>Open position</button>
              <button className={orderType === "limit" ? "on" : ""} onClick={() => setOrderType("limit")}>Limit order</button>
            </div>
            <span className="hint">
              {orderType === "market"
                ? "Already in the trade — enter the price you got."
                : "Waits for your price. I'll open it and message you when the market gets there."}
            </span>
          </div>

          <div className="field">
            <label>{orderType === "limit" ? "Limit price" : "Entry price"}</label>
            <input className={`input${bad("entry")}`} inputMode="decimal" value={entry} onChange={(e) => { setEntry(e.target.value); setEntryTouched(true); }} placeholder="0.00" />
            {limitGap !== undefined && (
              <span className="hint">
                {Math.abs(limitGap) < 0.05 ? "At the market price — would fill almost immediately" : `${pct(limitGap, 2)} ${limitGap < 0 ? "below" : "above"} the market`}
              </span>
            )}
          </div>

          <div className="field">
            <label>Size</label>
            <div className="pick">
              {units.map(([u, l]) => (
                <button key={u} className={sizeUnit === u ? "on" : ""} onClick={() => setSizeUnit(u)}>{l}</button>
              ))}
            </div>
            <div className="input-suffix">
              <input
                className={`input${bad("size")}`}
                inputMode="decimal"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder={sizeUnit === "token" ? "e.g. 0.1" : "e.g. 500"}
              />
              <span>{sizeUnit === "token" ? symbol : "USDT"}</span>
            </div>
            {sizeN > 0 && (
              <span className="hint">
                {type === "spot"
                  ? `= ${qty(coins)} ${symbol} · cost ${usd(coins * entryN)}`
                  : `= ${qty(coins)} ${symbol} · position ${usd(sizeN * lev)} · margin ${usd(sizeN)}`}
              </span>
            )}
          </div>

          {type === "perp" && (
            <div className="field">
              <label>Leverage: {leverage}x {sim?.liq ? `· liquidation ≈ ${price(sim.liq)}` : ""}</label>
              <input type="range" min={1} max={50} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-title">Your thesis</div>
        <div className="form">
          <div className="field">
            <label>Why are you taking this trade?</label>
            <textarea className={`textarea${bad("thesis")}`} value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder={PROMPTS[0]} maxLength={2000} />
            <div className="pick">
              {PROMPTS.slice(1).map((p) => (
                <button key={p} onClick={() => setThesis((t) => (t ? `${t}\n${p} ` : `${p} `))}>{p}</button>
              ))}
            </div>
          </div>

          <div className="input-row">
            <div className="field">
              <label>Target price</label>
              <input className={`input${bad("target")}`} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="optional" />
            </div>
            <div className="field">
              <label>Invalidation price</label>
              <input className={`input${bad("invalidation")}`} inputMode="decimal" value={invalidation} onChange={(e) => setInvalidation(e.target.value)} placeholder="I'm wrong if…" />
            </div>
          </div>

          <div className="field">
            <label>Invalidation (non-price)</label>
            <input className="input" value={invalidationText} onChange={(e) => setInvalidationText(e.target.value)} placeholder="e.g. ETF outflows for 2 weeks straight" />
          </div>

          <div className="field">
            <label>Horizon</label>
            <div className="pick">
              {HORIZONS.map((h) => <button key={h} className={horizon === h ? "on" : ""} onClick={() => setHorizon(h)}>{h}</button>)}
            </div>
          </div>

          <div className="field">
            <label>Conviction</label>
            <div className="dots">
              {[1, 2, 3, 4, 5].map((n) => <button key={n} className={conviction === n ? "on" : ""} onClick={() => setConviction(n)}>{n}</button>)}
            </div>
          </div>
        </div>
      </section>

      <MemoryCheck form={checkForm} onViolations={setBrokenRules} />

      {sim && (
        <section className="card">
          <div className="card-title">Simulation</div>
          <div className="preview">
            <div><span>At target</span><b className={sim.target && sim.target.pnl >= 0 ? "up" : ""}>{sim.target ? usd(sim.target.pnl, { sign: true }) : "—"}</b><small>{sim.target ? pct(sim.target.pnlPct, 1) : "set target"}</small></div>
            <div><span>At invalidation</span><b className={sim.invalidation ? "down" : ""}>{sim.invalidation ? usd(sim.invalidation.pnl, { sign: true }) : "—"}</b><small>{sim.invalidation ? pct(sim.invalidation.pnlPct, 1) : "set level"}</small></div>
            <div><span>Risk / reward</span><b>{sim.target && sim.invalidation && sim.invalidation.pnl < 0 ? `1 : ${(sim.target.pnl / -sim.invalidation.pnl).toFixed(1)}` : "—"}</b><small>{type === "perp" ? `${leverage}x` : "spot"}</small></div>
          </div>
          {liqBeforeInvalidation && (
            <p className="hint mt" style={{ color: "var(--warn)" }}>
              ⚠ You'd be liquidated at {price(sim.liq)} before your invalidation is reached. Lower the leverage or move the level.
            </p>
          )}
        </section>
      )}

      <div className="mt">
        <button className="btn dark" disabled={saving} onClick={submit}>
          {saving ? <Spinner /> : null} {orderType === "limit" ? "Place order & seal thesis" : "Seal thesis on Walrus"}
        </button>
        {brokenRules > 0 && (
          <p className="small" style={{ textAlign: "center", margin: "10px 8px 0", color: "#a32121", fontWeight: 600 }}>
            This trade breaks {brokenRules} of your own rules. You can still open it — it will be noted in your memory.
          </p>
        )}
        <p className="small muted" style={{ textAlign: "center", margin: "10px 8px 0" }}>
          Your thesis is encrypted and stored in your Walrus Memory with a sha256 fingerprint — it can't be edited later.
        </p>
      </div>
    </div>
  );
}
