import { useState } from "react";
import { api, type Position } from "../api";
import { go, TopBar, useLive, useLoad } from "../components";
import { HoldingRow } from "./Home";

type Tab = "open" | "orders" | "closed";

const TABS: Array<{ id: Tab; label: string; match: (p: Position) => boolean }> = [
  { id: "open", label: "Open", match: (p) => p.status === "open" },
  { id: "orders", label: "Orders", match: (p) => p.status === "pending" },
  { id: "closed", label: "Closed", match: (p) => p.status === "closed" || p.status === "cancelled" },
];

const EMPTY: Record<Tab, [string, string]> = {
  open: ["No open positions", "Every position starts with a thesis."],
  orders: ["No limit orders", "Place a limit order and I'll open it when the price gets there."],
  closed: ["Nothing closed yet", "Closed trades and their lessons show up here."],
};

export function Positions() {
  const { data, loading, error, reload } = useLoad(api.portfolio);
  useLive(reload);
  const [tab, setTab] = useState<Tab>("open");
  const all = data?.positions ?? [];
  const list = all.filter(TABS.find((t) => t.id === tab)!.match);

  return (
    <div className="fade-in">
      <TopBar />
      <section className="card">
        <div className="segmented" style={{ marginBottom: 12 }}>
          {TABS.map((t) => {
            const n = all.filter(t.match).length;
            return (
              <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
                {t.label}{n ? ` · ${n}` : ""}
              </button>
            );
          })}
        </div>
        {loading && !data ? (
          <div className="empty"><p>Loading…</p></div>
        ) : error ? (
          <div className="empty"><p>{error}</p></div>
        ) : list.length ? (
          list.map((p) => <HoldingRow key={p.id} p={p} />)
        ) : (
          <div className="empty">
            <b>{EMPTY[tab][0]}</b>
            <p>{EMPTY[tab][1]}</p>
            {tab !== "closed" && <button className="btn primary" onClick={() => go("/new")}>New thesis</button>}
          </div>
        )}
      </section>
    </div>
  );
}
