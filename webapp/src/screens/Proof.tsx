import { api } from "../api";
import { go, Icon, TopBar, useLoad } from "../components";
import { date, pct, price, shortHash, time } from "../format";
import { openLink, shareText } from "../telegram";

const OUTCOME = { right: "Thesis right", partial: "Partly right", wrong: "Thesis wrong", unclear: "Unclear" } as const;

export function Proof() {
  const { data, loading } = useLoad(api.proof);
  const sealed = (data ?? []).filter((r) => r.proof.status === "stored").length;
  const judged = (data ?? []).filter((r) => r.thesisOutcome && r.thesisOutcome !== "unclear");
  // Same scoring as the server's thesis accuracy: a partial call counts as half.
  const right = judged.reduce((n, r) => n + (r.thesisOutcome === "right" ? 1 : r.thesisOutcome === "partial" ? 0.5 : 0), 0);

  const verifyUrl = (id: string) => `${window.location.origin}${window.location.pathname}#/verify/${id}`;
  const revealed = (data ?? []).filter((r) => r.revealed);

  function share() {
    if (revealed.length) {
      const lines = revealed.slice(0, 5).map(
        (r) => `${date(r.placedAt)} ${r.side.toUpperCase()} ${r.symbol} @ ${price(r.entryPrice)}${r.pnlPct !== undefined ? ` → ${pct(r.pnlPct, 1)}` : ""}\n${verifyUrl(r.id)}`,
      );
      return shareText(`My trade theses — committed on Walrus before the move, verify each one:\n\n${lines.join("\n\n")}`);
    }
    const lines = (data ?? []).slice(0, 5).map(
      (r) => `${date(r.placedAt)} ${r.side.toUpperCase()} ${r.symbol} @ ${price(r.entryPrice)}${r.pnlPct !== undefined ? ` → ${pct(r.pnlPct, 1)}` : r.status === "pending" ? " (limit order)" : " (open)"}${r.proofUrl ? `\n${r.proofUrl}` : ""}`,
    );
    shareText(`My trade theses, timestamped on Walrus before the move:\n\n${lines.join("\n\n")}`);
  }

  return (
    <div className="fade-in">
      <TopBar title="Track record" back="" />

      <section className="card">
        <div className="eyebrow">Verifiable theses</div>
        <div className="big-number">{sealed}<span className="dec"> / {data?.length ?? 0}</span></div>
        <div className="chips">
          <span className="chip"><Icon.shield />sealed on Walrus</span>
          {judged.length > 0 && <span className="chip">{Math.round((right / judged.length) * 100)}% called right</span>}
        </div>
        <p className="small" style={{ color: "var(--on-navy-soft)", lineHeight: 1.5, marginBottom: 0 }}>
          Each thesis was written to Walrus at the moment you opened the trade. The blob and its on-chain registration
          prove when it existed; the sha256 fingerprint proves what it said.
        </p>
        {data && data.length > 0 && (
          <div className="mt"><button className="btn" onClick={share}><Icon.share /> Share track record</button></div>
        )}
      </section>

      {loading && !data && <div className="skeleton mt" />}

      {(data ?? []).map((r, i) => (
        <div className={`tab-card ${i % 2 ? "navy" : ""}`} key={r.id}>
          <div className="tab-card-head">
            <div className="tab-card-label">{r.status === "open" ? "Open" : r.status === "pending" ? "Limit order" : r.status === "cancelled" ? "Cancelled" : OUTCOME[r.thesisOutcome ?? "unclear"]}</div>
            <div className="tab-card-meta">
              <span><Icon.clock />{time(r.placedAt)}</span>
              <span><Icon.calendar />{date(r.placedAt)}</span>
            </div>
          </div>
          <div className="tab-card-body" onClick={() => go(`/position/${r.id}`)} style={{ cursor: "pointer" }}>
            <div className="tab-card-title">{r.side.toUpperCase()} {r.symbol} {r.type === "perp" ? `${r.leverage}x` : "spot"} @ {price(r.entryPrice)}</div>
            <p className="quote" style={{ fontSize: 14 }}>“{r.thesis.text.slice(0, 180)}{r.thesis.text.length > 180 ? "…" : ""}”</p>
            <div className="chips mt">
              {r.pnlPct !== undefined && <span className="chip">{pct(r.pnlPct, 1)}</span>}
              {r.thesis.targetPrice && <span className="chip">target {price(r.thesis.targetPrice)}</span>}
            </div>
            <div className="tab-card-foot">
              <span className="row">
                <span className="hash">sha256 {shortHash(r.commitment?.hash ?? r.proof.hash)}</span>
                {r.revealed && <span className="badge stored">Public</span>}
              </span>
              {r.proofUrl ? (
                <button className="link-btn" onClick={(e) => { e.stopPropagation(); openLink(r.proofUrl!); }}>Walruscan ↗</button>
              ) : (
                <span className="small">{r.proof.status}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
