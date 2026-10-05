import { api, type Me, type Position } from "../api";
import { Avatar, Bars, go, Icon, LiveValue, PnlChip, TopBar, useLive, useLoad } from "../components";
import { pct, price, splitMoney, usd } from "../format";

export function HoldingRow({ p }: { p: Position }) {
  const m = p.metrics;
  const up = (m?.pnl ?? 0) >= 0;
  return (
    <button className="holding" onClick={() => go(`/position/${p.id}`)}>
      <Avatar symbol={p.symbol} />
      <div className="holding-main">
        <div className="holding-name">{p.symbol} {p.type === "perp" ? `${p.leverage}x` : "spot"}</div>
        <div className="holding-sub">
          <span className={`tag ${p.side}`}>{p.side.toUpperCase()}</span>
          {p.status === "pending" && <span className="tag order">LIMIT</span>}
          <span className="snippet">{p.status === "closed" ? "closed" : p.status === "cancelled" ? "order cancelled" : p.thesis.text}</span>
        </div>
      </div>
      <div className="holding-right">
        {p.status === "pending" || p.status === "cancelled" ? (
          <>
            <div className="holding-value">@ {price(p.entryPrice)}</div>
            <div className="holding-pnl" style={{ color: "var(--on-navy-soft)" }}>
              {p.status === "cancelled" ? "cancelled" : p.distanceToLimitPct !== undefined ? `${pct(p.distanceToLimitPct, 1)} away` : "waiting"}
            </div>
          </>
        ) : (
          <div className="holding-value"><LiveValue value={m?.value}>{m ? usd(m.value) : "—"}</LiveValue></div>
        )}
        {m && (
          <div className={`holding-pnl ${up ? "up" : "down"}`}>
            {up ? <Icon.trend /> : <Icon.down />}
            <LiveValue value={m.pnl}>{usd(m.pnl, { sign: true })} · {pct(m.pnlPct, 1)}</LiveValue>
          </div>
        )}
      </div>
    </button>
  );
}

export function Home({ me }: { me?: Me }) {
  const { data, loading, error, reload } = useLoad(api.portfolio);
  useLive(reload);

  if (loading && !data) return <><TopBar /><div className="skeleton" /><div className="skeleton mt" /></>;
  if (error) return <><TopBar /><div className="banner"><div><b>Could not load portfolio</b>{error}</div></div></>;
  if (!data) return null;

  const [int, dec] = splitMoney(data.value);
  const open = data.positions.filter((p) => p.status === "open");
  const pending = data.positions.filter((p) => p.status === "pending");
  const active = [...open, ...pending];

  return (
    <div className="fade-in">
      <TopBar />

      {me?.memoryMode === "local" && (
        <div className="banner">
          <Icon.shield />
          <div><b>Local memory mode</b>Walrus credentials are not configured on the server, so memories are stored locally.</div>
        </div>
      )}

      <section className="card">
        <div className="eyebrow"><span className="live-dot" />Open Positions Value</div>
        <div className="big-number"><LiveValue value={data.value}>{int}<span className="dec">{dec}</span></LiveValue></div>
        <div className="chips">
          <PnlChip percent={data.unrealizedPct} />
          <span className="chip">{usd(data.unrealized, { sign: true })} · Unrealized</span>
          {data.realized !== 0 && <span className="chip">{usd(data.realized, { sign: true })} · Realized</span>}
          {pending.length > 0 && <span className="chip">⏳ {pending.length} limit {pending.length === 1 ? "order" : "orders"}</span>}
        </div>
        <div className="actions">
          <button className="action" onClick={() => go("/new")}><Icon.plus />New Thesis</button>
          <button className="action" onClick={() => go("/coach")}><Icon.pulse />Check-in</button>
          <button className="action" onClick={() => go("/proof")}><Icon.shield />Proof</button>
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          Open Positions
          <button onClick={() => go("/positions")}>See All</button>
        </div>
        {active.length ? (
          active.slice(0, 5).map((p) => <HoldingRow key={p.id} p={p} />)
        ) : (
          <div className="empty">
            <b>No open positions</b>
            <p>Write down why you're entering before you enter. That's the whole trick.</p>
            <button className="btn primary" onClick={() => go("/new")}>Add your first thesis</button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-title">
          Realized PnL
          <button onClick={() => go("/memory")}>{data.memoryCount} memories</button>
        </div>
        <Bars months={data.months} />
        <div className="chips mt">
          <span className="chip"><Icon.brain />{data.storedOnWalrus} sealed on Walrus</span>
          <span className="chip">{data.closedCount} closed trades</span>
        </div>
      </section>
    </div>
  );
}
