import { useEffect, useState } from "react";
import { api, type Me, type Recalled } from "../api";
import { Icon, MemoryBadge, Spinner, toast, TopBar, useLoad } from "../components";
import { ago } from "../format";
import { haptic, openLink } from "../telegram";
import { MemoryAccountCard } from "./MemoryAccount";
import { RulesCard } from "./Rules";

function InsightsCard() {
  const { data, loading, reload, setData } = useLoad(() => api.insights());
  const [refreshing, setRefreshing] = useState(false);
  const s = data?.stats;

  return (
    <section className="card">
      <div className="card-title">
        Trader DNA
        <button
          onClick={async () => {
            setRefreshing(true);
            try { setData(await api.insights(true)); } catch (e) { toast((e as Error).message, true); }
            setRefreshing(false);
          }}
        >
          {refreshing ? "Analysing…" : "Refresh"}
        </button>
      </div>
      {loading && !data ? (
        <p className="eyebrow">Reading your memory…</p>
      ) : data ? (
        <>
          <p style={{ margin: "0 0 14px", fontSize: 17, fontWeight: 500, lineHeight: 1.35 }}>{data.headline}</p>
          <div className="stat-grid">
            <div className="stat"><span>Thesis accuracy</span><b>{s?.thesisAccuracy ?? "—"}{s?.thesisAccuracy != null ? "%" : ""}</b></div>
            <div className="stat"><span>Win rate</span><b>{s?.winRate ?? "—"}{s?.winRate != null ? "%" : ""}</b></div>
            <div className="stat"><span>Avg. hold</span><b>{s?.avgHoldDays ?? "—"}{s?.avgHoldDays != null ? "d" : ""}</b></div>
            <div className="stat"><span>Memories</span><b>{s?.memories ?? 0}</b></div>
          </div>
          {data.patterns.length > 0 && (
            <div className="mt">
              {data.patterns.map((p) => (
                <div className="pattern" key={p.title}>
                  <h4>{p.title}</h4>
                  <p>{p.evidence}</p>
                  <p className="rule">→ {p.advice}</p>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <button className="btn ghost" onClick={() => void reload()}>Try again</button>
      )}
    </section>
  );
}

export function Memory({ me }: { me?: Me }) {
  const { data: journal, reload } = useLoad(api.journal);

  // Walrus writes take ~20s — keep polling while anything is still being sealed.
  const pending = journal?.some((j) => j.memory.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(t);
  }, [pending, reload]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Recalled[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return setResults(null);
    setSearching(true);
    try {
      setResults(await api.recall(query.trim()));
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setSearching(false);
    }
  }

  async function saveNote() {
    setSaving(true);
    try {
      await api.note(note);
      setNote("");
      haptic.success();
      toast("Saved to your memory");
      void reload();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fade-in">
      <TopBar />

      <InsightsCard />

      <RulesCard />

      <MemoryAccountCard />

      <div className="section">
        <h2>Ask your memory</h2>
        <form onSubmit={search} className="row">
          <input className="light-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="When did I panic sell?" />
          <button className="icon-btn" type="submit" aria-label="Search">{searching ? <Spinner /> : <Icon.search />}</button>
        </form>
        {results && (
          <div className="timeline mt">
            {results.length ? results.map((r, i) => (
              <div className="mem fade-in" key={i}>
                <div className="mem-head"><span className="mem-kind">match</span><span>distance {r.distance.toFixed(2)}</span></div>
                <div className="mem-text">{r.text}</div>
                {r.proofUrl && <div className="mem-foot"><button className="link-btn" onClick={() => openLink(r.proofUrl!)}>View blob ↗</button></div>}
              </div>
            )) : <p className="muted small">Nothing relevant found.</p>}
          </div>
        )}
      </div>

      <section className="card">
        <div className="card-title">Journal a thought</div>
        <div className="form">
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="A rule, a mistake, a market observation…" />
          <button className="btn primary" disabled={saving || note.trim().length < 3} onClick={saveNote}>
            {saving ? <Spinner /> : null} Remember this
          </button>
        </div>
      </section>

      <div className="section">
        <h2>Timeline</h2>
        <p className="small muted" style={{ marginTop: -4 }}>
          {me?.memoryMode !== "walrus"
            ? "Local memory mode."
            : me.memorySpace === "user"
              ? `Your own Walrus Memory account, namespace “${me.namespace}”.`
              : `Encrypted memory space “${me.namespace}” on Walrus ${me.network}.`}
        </p>
        <div className="timeline">
          {(journal ?? []).map((j) => (
            <div className="mem" key={j.id}>
              <div className="mem-head"><span className="mem-kind">{j.kind}</span><span>{ago(j.createdAt)}</span></div>
              <div className="mem-text">{j.text.replace(/^\[[A-Z-]+\]\s*/, "")}</div>
              <div className="mem-foot"><MemoryBadge entry={j} /></div>
            </div>
          ))}
          {journal && !journal.length && <p className="muted small">No memories yet.</p>}
        </div>
      </div>
    </div>
  );
}
