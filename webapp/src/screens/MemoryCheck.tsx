import { useEffect, useRef, useState } from "react";
import { api, type Precheck } from "../api";
import { Icon, Spinner } from "../components";
import { pct } from "../format";
import { openLink } from "../telegram";

const DEBOUNCE_MS = 900;

/** Strips the "[KIND] 2026-10-04 14:36 UTC · " prefix and keeps the date for display. */
function splitMemory(text: string): { date?: string; body: string } {
  const m = text.match(/^\[[A-Z -]+\]\s*(\d{4}-\d{2}-\d{2})?[^·]*·\s*/u);
  return m ? { date: m[1], body: text.slice(m[0].length) } : { body: text };
}

/**
 * "Before you enter": live feedback from the user's Walrus Memory while they fill in a position.
 * `form` is the same payload the create endpoint takes; it's re-checked after the user pauses typing.
 */
export function MemoryCheck({ form, onViolations }: { form: Record<string, unknown> | null; onViolations: (n: number) => void }) {
  const [data, setData] = useState<Precheck | null>(null);
  const [loading, setLoading] = useState(false);
  const key = form ? JSON.stringify(form) : "";
  const latest = useRef(key);

  useEffect(() => {
    latest.current = key;
    if (!form) return;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await api.precheck(form);
        if (latest.current !== key) return; // a newer request superseded this one
        setData(res);
        onViolations(res.violations.length);
      } catch {
        // the check is advisory — never block the form on it
      } finally {
        if (latest.current === key) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!form) return null;
  const rec = data?.record;
  const hasHistory = rec && (rec.sameSymbol.count > 0 || (rec.highLeverage?.count ?? 0) > 0);
  const nothing = data && !data.violations.length && !data.similar.length && !hasHistory;

  return (
    <section className="card memcheck">
      <div className="card-title">
        <span className="row"><Icon.brain /> Memory check</span>
        {loading ? <Spinner /> : null}
      </div>

      {!data && loading && <p className="eyebrow">Searching your Walrus Memory for trades like this…</p>}

      {data && data.violations.length > 0 && (
        <div className="violations">
          {data.violations.map((v) => (
            <div className="violation" key={v.ruleId}>
              <b>⚠ Breaks your rule: “{v.rule}”</b>
              <span>{v.detail}</span>
            </div>
          ))}
        </div>
      )}

      {data?.summary && <p className="memcheck-summary">{data.summary}</p>}

      {hasHistory && (
        <div className="chips">
          {rec!.sameSymbol.count > 0 && (
            <span className="chip">
              {rec!.sameSymbol.count} past {form.symbol as string} {rec!.sameSymbol.count === 1 ? "trade" : "trades"} · {rec!.sameSymbol.wins} won
              {rec!.sameSymbol.avgPnlPct !== null ? ` · avg ${pct(rec!.sameSymbol.avgPnlPct, 0)}` : ""}
            </span>
          )}
          {rec!.highLeverage && rec!.highLeverage.count > 0 && (
            <span className={`chip ${rec!.highLeverage.wiped ? "down" : ""}`}>
              High leverage: {rec!.highLeverage.count} trades · {rec!.highLeverage.wiped} wiped out
            </span>
          )}
        </div>
      )}

      {data && data.similar.length > 0 && (
        <div className="memcheck-list">
          <span className="hint">From your memory</span>
          {data.similar.map((m, i) => {
            const { date, body } = splitMemory(m.text);
            return (
              <div className="memcheck-item" key={i}>
                {date && <span className="memcheck-date">{date}</span>}
                <span>{body.length > 220 ? `${body.slice(0, 220)}…` : body}</span>
                {m.proofUrl && <button className="link-btn" onClick={() => openLink(m.proofUrl!)}>Walrus ↗</button>}
              </div>
            );
          })}
        </div>
      )}

      {nothing && <p className="eyebrow">Nothing in your memory about trades like this yet — this thesis will be the first.</p>}
    </section>
  );
}
