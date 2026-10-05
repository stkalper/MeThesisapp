import { useEffect, useState } from "react";
import { api, type PublicThesis } from "../api";
import { Brand, Spinner } from "../components";
import { date, price, shortHash, time } from "../format";
import { openLink } from "../telegram";

type Step = "pending" | "ok" | "fail";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const OUTCOME = { right: "Thesis played out", partial: "Partly right", wrong: "Thesis was wrong", unclear: "Unclear" } as const;

/**
 * Public, no-login page. Everything that matters is checked in the visitor's browser:
 * 1. sha256 of the revealed thesis text is computed locally,
 * 2. the commitment blob is fetched straight from a Walrus aggregator (not from our server),
 * 3. the two hashes must match; the blob's Sui object dates the commitment.
 */
export function Verify({ id }: { id: string }) {
  const [data, setData] = useState<PublicThesis>();
  const [error, setError] = useState<string>();
  const [hashStep, setHashStep] = useState<Step>("pending");
  const [blobStep, setBlobStep] = useState<Step>("pending");
  const [computed, setComputed] = useState<string>();
  const [committedAt, setCommittedAt] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        const d = await api.publicThesis(id);
        setData(d);
        const h = await sha256Hex(d.payload);
        setComputed(h);
        setHashStep(h === d.commitment.sha256 ? "ok" : "fail");
        try {
          const blob = await (await fetch(d.commitment.aggregatorUrl)).json();
          setCommittedAt(blob.committedAt);
          setBlobStep(blob.sha256 === h ? "ok" : "fail");
        } catch {
          setBlobStep("fail");
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [id]);

  if (error) {
    return (
      <div className="fade-in">
        <div className="topbar"><Brand /></div>
        <div className="card"><div className="card-title">Not available</div><p className="eyebrow">{error}</p></div>
      </div>
    );
  }
  if (!data) return <><div className="topbar"><Brand /></div><div className="skeleton" /></>;

  const t = JSON.parse(data.payload) as {
    symbol: string; type: string; side: string; orderType: string; entryPrice: number; leverage: number; placedAt: string;
    thesis: { text: string; targetPrice?: number; invalidationPrice?: number; invalidationText?: string; horizon?: string; conviction: number };
  };
  const verified = hashStep === "ok" && blobStep === "ok";
  const icon = (s: Step) => (s === "ok" ? "✅" : s === "fail" ? "❌" : <Spinner />);

  return (
    <div className="fade-in">
      <div className="topbar"><Brand /></div>

      <section className="card">
        <div className="eyebrow">{verified ? "Verified thesis" : blobStep === "fail" || hashStep === "fail" ? "Verification failed" : "Verifying…"}</div>
        <div className="big-number" style={{ fontSize: 30 }}>
          {t.side.toUpperCase()} {t.symbol} {t.type === "perp" ? `${t.leverage}x` : "spot"}
        </div>
        <div className="chips">
          <span className="chip">{t.orderType === "limit" ? "Limit" : "Entry"} {price(t.entryPrice)}</span>
          {t.thesis.targetPrice && <span className="chip">Target {price(t.thesis.targetPrice)}</span>}
          {t.thesis.invalidationPrice && <span className="chip">Wrong {t.side === "short" ? "above" : "below"} {price(t.thesis.invalidationPrice)}</span>}
        </div>
        <p className="quote" style={{ marginTop: 16 }}>“{t.thesis.text}”</p>
        <p className="hint" style={{ marginTop: 10 }}>
          Written {date(t.placedAt)} {time(t.placedAt)}
          {t.thesis.horizon ? ` · horizon ${t.thesis.horizon}` : ""} · conviction {t.thesis.conviction}/5
        </p>
        {data.status === "closed" && (
          <div className="chips mt">
            <span className="chip">Closed {data.closedAt ? date(data.closedAt) : ""} at {price(data.exitPrice)}</span>
            {data.thesisOutcome && <span className="chip">{OUTCOME[data.thesisOutcome]}</span>}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-title">How this is verified</div>
        <div className="verify-steps">
          <div>
            <span>{icon(hashStep)}</span>
            <p>
              <b>sha256 of the thesis above</b>, computed in your browser:
              <br /><span className="hash">{computed ? shortHash(computed) : "…"}</span>
            </p>
          </div>
          <div>
            <span>{icon(blobStep)}</span>
            <p>
              <b>Public commitment on Walrus {data.commitment.network}</b> holds the same hash
              {committedAt ? `, committed ${date(committedAt)} ${time(committedAt)}` : ""}. Fetched directly from a Walrus aggregator.
            </p>
          </div>
          <div>
            <span>🔗</span>
            <p>
              The commitment blob is a Sui object — its creation transaction proves when it was registered, independently of this app.
            </p>
          </div>
        </div>
        <div className="btn-row mt">
          <button className="btn ghost" onClick={() => openLink(data.commitment.walruscanUrl)}>Walrus blob ↗</button>
          {data.commitment.suiObjectUrl && <button className="btn ghost" onClick={() => openLink(data.commitment.suiObjectUrl!)}>Sui object ↗</button>}
        </div>
        <details className="portable mt">
          <summary>Verify it yourself</summary>
          <p>
            Hash the exact text below with sha256 and compare it with the <span className="hash">sha256</span> field of the blob at{" "}
            <span className="hash" style={{ wordBreak: "break-all" }}>{data.commitment.aggregatorUrl}</span>
          </p>
          <pre className="payload">{data.payload}</pre>
        </details>
      </section>

      <p className="small muted" style={{ textAlign: "center", margin: "16px 8px 0" }}>
        Tracked with Thesis Keeper — trade theses sealed in Walrus Memory.
      </p>
    </div>
  );
}
