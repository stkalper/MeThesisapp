import { useState } from "react";
import { api, type TradingRule } from "../api";
import { Spinner, toast, useLoad } from "../components";
import { date } from "../format";
import { haptic } from "../telegram";

const SOURCE: Record<TradingRule["source"], string> = {
  lesson: "from a lesson",
  note: "from a note",
  chat: "from chat",
  manual: "added by you",
};

const EXAMPLES = ["Never more than 5x on altcoins", "Always set an invalidation", "Minimum risk/reward 1:2"];

export function RulesCard() {
  const { data, reload } = useLoad(api.rules);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string>();

  async function add(value = text) {
    if (value.trim().length < 5) return;
    setBusy(true);
    try {
      await api.addRule(value.trim());
      setText("");
      haptic.success();
      toast("Rule saved to your memory — new positions are checked against it");
      void reload();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (confirm !== id) return setConfirm(id);
    try {
      await api.deleteRule(id);
      setConfirm(undefined);
      void reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  const rules = data ?? [];

  return (
    <section className="card">
      <div className="card-title">My rules <span className="hint">{rules.length || ""}</span></div>
      <p className="eyebrow" style={{ marginTop: -6 }}>
        Learned from your lessons, notes and chat — every new position is checked against them.
      </p>

      {rules.map((r) => (
        <div className="rule" key={r.id}>
          <div className="rule-main">
            {r.text}
            <div className="rule-meta">
              <span className={`badge ${r.check ? "stored" : "local"}`}>{r.check ? "Enforced" : "Reminder"}</span>
              <span className="hint">{SOURCE[r.source]} · {date(r.createdAt)}</span>
            </div>
          </div>
          <button className={`rule-del ${confirm === r.id ? "confirm" : ""}`} onClick={() => void remove(r.id)}>
            {confirm === r.id ? "Remove?" : "✕"}
          </button>
        </div>
      ))}

      {!rules.length && (
        <div className="pick" style={{ margin: "4px 0 12px" }}>
          {EXAMPLES.map((e) => <button key={e} onClick={() => void add(e)} disabled={busy}>+ {e}</button>)}
        </div>
      )}

      <div className="row mt">
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          placeholder="Add a rule in your own words"
        />
        <button className="btn primary" style={{ width: "auto", padding: "13px 18px" }} disabled={busy || text.trim().length < 5} onClick={() => void add()}>
          {busy ? <Spinner /> : "Add"}
        </button>
      </div>
    </section>
  );
}
