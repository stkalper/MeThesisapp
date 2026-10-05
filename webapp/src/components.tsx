import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { JournalEntry } from "./api";
import { pct, usd } from "./format";
import { haptic, openLink } from "./telegram";

// ---------- routing (hash based, works inside Telegram) ----------

export function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => {
      setRoute(window.location.hash.slice(1) || "/");
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path: string) => {
  haptic.tap();
  window.location.hash = path;
};

// ---------- data loading ----------

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const hasData = useRef(false);
  const inFlight = useRef(false);
  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await fn());
      hasData.current = true;
      setError(undefined);
    } catch (err) {
      // A failed background refresh keeps showing the last good data instead of an error screen.
      if (!hasData.current) setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Live prices refresh interval. */
export const LIVE_MS = 5_000;

/**
 * Calls `fn` every `ms` while `enabled`, pausing while the Mini App is hidden
 * (minimised / phone locked) and refreshing immediately when it comes back.
 */
export function useLive(fn: () => unknown, enabled = true, ms = LIVE_MS) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => void saved.current(), ms);
    };
    const onVisibility = () => {
      if (document.hidden) window.clearInterval(timer);
      else {
        void saved.current();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, ms]);
}

/** Returns "flash-up" / "flash-down" for a moment after `value` changes, to make ticks visible. */
export function useFlash(value: number | undefined): string {
  const prev = useRef(value);
  const [cls, setCls] = useState("");
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before === undefined || value === undefined || before === value) return;
    setCls(value > before ? "flash-up" : "flash-down");
    const t = window.setTimeout(() => setCls(""), 900);
    return () => window.clearTimeout(t);
  }, [value]);
  return cls;
}

/** A number that briefly glows green/red when it changes. */
export function LiveValue({ value, children, className = "" }: { value: number | undefined; children: ReactNode; className?: string }) {
  const flash = useFlash(value);
  return <span className={`live ${flash} ${className}`}>{children}</span>;
}

// ---------- toast ----------

let pushToast: ((t: { text: string; error?: boolean }) => void) | undefined;
export const toast = (text: string, error = false) => {
  if (error) haptic.error();
  pushToast?.({ text, error });
};

export function ToastHost() {
  const [t, setT] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    pushToast = (next) => {
      setT(next);
      window.setTimeout(() => setT((cur) => (cur === next ? null : cur)), 3200);
    };
    return () => {
      pushToast = undefined;
    };
  }, []);
  return t ? <div className={`toast fade-in ${t.error ? "error" : ""}`}>{t.text}</div> : null;
}

// ---------- icons (stroke, 24px grid) ----------

const I = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const Icon = {
  trend: () => <I><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></I>,
  down: () => <I><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></I>,
  plus: () => <I><path d="M12 5v14M5 12h14" /></I>,
  home: () => <I><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></I>,
  chart: () => <I><path d="M5 20V10M10 20V4M15 20v-7M20 20v-4" /></I>,
  chat: () => <I><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" /></I>,
  brain: () => <I><path d="M9 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3V4z" /><path d="M15 4a3 3 0 0 1 3 3v.2a3 3 0 0 1 2 2.8 3 3 0 0 1-1 2.2 3 3 0 0 1-1 4.8 3 3 0 0 1-3 3V4z" /></I>,
  shield: () => <I><path d="M12 3l8 3v6c0 4.4-3.4 8-8 9-4.6-1-8-4.6-8-9V6z" /><path d="M9 12l2 2 4-4" /></I>,
  pulse: () => <I><path d="M3 12h4l3-7 4 14 3-7h4" /></I>,
  bell: () => <I><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></I>,
  menu: () => <I><path d="M5 7h14M8 12h11M11 17h8" /></I>,
  back: () => <I><path d="M15 5l-7 7 7 7" /></I>,
  clock: () => <I><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></I>,
  calendar: () => <I><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></I>,
  send: () => <I><path d="M5 12l14-7-5 15-2.5-6.5z" /></I>,
  search: () => <I><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></I>,
  link: () => <I><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></I>,
  share: () => <I><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></I>,
  x: () => <I><path d="M6 6l12 12M18 6L6 18" /></I>,
};

// ---------- layout ----------

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><i /><i /><i /></span>
      Thesis Keeper
    </div>
  );
}

export function TopBar({ title, back }: { title?: string; back?: string }) {
  return (
    <div className="topbar">
      {back !== undefined ? (
        <button className="back-btn" onClick={() => (back ? go(back) : history.back())}>
          <Icon.back /> {title}
        </button>
      ) : (
        <Brand />
      )}
      <div className="topbar-actions">
        <button className="icon-btn" aria-label="Memory" onClick={() => go("/memory")}><Icon.bell /></button>
        <button className="icon-btn" aria-label="Track record" onClick={() => go("/proof")}><Icon.menu /></button>
      </div>
    </div>
  );
}

const NAV = [
  { path: "/", label: "Home", icon: Icon.home },
  { path: "/positions", label: "Positions", icon: Icon.chart },
  { path: "/new", label: "", icon: Icon.plus },
  { path: "/coach", label: "Coach", icon: Icon.chat },
  { path: "/memory", label: "Memory", icon: Icon.brain },
];

export function BottomNav({ route }: { route: string }) {
  return (
    <nav className="nav">
      {NAV.map(({ path, label, icon: Ic }) =>
        path === "/new" ? (
          <button key={path} onClick={() => go(path)} aria-label="New thesis">
            <span className="plus"><Ic /></span>
          </button>
        ) : (
          <button key={path} className={route === path || (path !== "/" && route.startsWith(path)) ? "on" : ""} onClick={() => go(path)}>
            <Ic />
            {label}
          </button>
        ),
      )}
    </nav>
  );
}

// ---------- small pieces ----------

export function Avatar({ symbol }: { symbol: string }) {
  return <div className="avatar">{symbol.slice(0, 3)}</div>;
}

export function PnlChip({ value, percent, suffix }: { value?: number; percent?: number; suffix?: string }) {
  const n = percent ?? value ?? 0;
  const up = n >= 0;
  return (
    <span className={`chip ${up ? "up" : "down"}`}>
      {up ? <Icon.trend /> : <Icon.down />}
      {percent !== undefined ? pct(percent) : usd(value, { sign: true })}
      {suffix ? <span style={{ color: "rgba(255,255,255,.75)" }}>{suffix}</span> : null}
    </span>
  );
}

export function MemoryBadge({ entry }: { entry: Pick<JournalEntry, "memory"> & { proofUrl?: string } }) {
  const s = entry.memory.status;
  const yours = s === "stored" && entry.memory.space === "user";
  const label = yours ? "Your Walrus" : { stored: "On Walrus", pending: "Sealing…", failed: "Not stored", local: "Local only" }[s];
  return (
    <>
      <span className={`badge ${yours ? "yours" : s}`}>{s === "pending" ? <span className="spin" style={{ width: 10, height: 10 }} /> : null}{label}</span>
      {entry.proofUrl ? (
        <button className="link-btn" onClick={() => openLink(entry.proofUrl!)}>View blob ↗</button>
      ) : null}
    </>
  );
}

export function Spinner() {
  return <span className="spin" />;
}

// ---------- charts ----------

/** Stacked monthly bars — profit (light) under loss (navy), like the reference dashboard. */
export function Bars({ months }: { months: Array<{ month: string; profit: number; loss: number }> }) {
  const W = 340, H = 150, padR = 44, padB = 22, padT = 8;
  const max = Math.max(1, ...months.map((m) => m.profit + m.loss));
  const nice = niceMax(max);
  const bw = 26;
  const step = (W - padR) / months.length;
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / nice);
  const tick = (v: number) => (v >= 1000 ? `$${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : `$${Math.round(v)}`);
  return (
    <div className="bars">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Realized PnL per month">
        {[0, 0.33, 0.66, 1].map((f) => (
          <g key={f}>
            <line x1={0} x2={W - padR + 4} y1={y(nice * f)} y2={y(nice * f)} stroke="rgba(255,255,255,.18)" strokeDasharray="4 5" />
            <text x={W - 2} y={y(nice * f) + 4} fill="rgba(255,255,255,.75)" fontSize="11" textAnchor="end">{tick(nice * f)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const x = i * step + (step - bw) / 2;
          const pTop = y(m.profit);
          const lTop = y(m.profit + m.loss);
          const label = new Date(`${m.month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
          return (
            <g key={m.month}>
              <title>{`${label}: +${usd(m.profit)} / -${usd(m.loss)}`}</title>
              {m.loss > 0 && <rect x={x} y={lTop} width={bw} height={pTop - lTop} fill="#3b5378" />}
              {m.profit > 0 && <rect x={x} y={pTop} width={bw} height={H - padB - pTop} fill="#7db8f0" />}
              {m.profit + m.loss > 0 && <rect x={x} y={lTop} width={bw} height={2} fill="#fff" />}
              <text x={x + bw / 2} y={H - 4} fill="rgba(255,255,255,.75)" fontSize="11" textAnchor="middle">{label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 3, 5, 10].map((m) => m * p).find((c) => c >= v) ?? v;
}

/**
 * Ring gauge after the reference: a thick navy arc (progress) and a light arc (remaining),
 * each with a label running along it.
 */
export function Ring({
  progress,
  center,
  caption,
  doneLabel,
  restLabel,
}: {
  progress: number;
  center: ReactNode;
  caption: ReactNode;
  doneLabel: string;
  restLabel: string;
}) {
  const f = Math.min(1, Math.max(0.02, progress));
  const size = 300, cx = 150, cy = 150, r = 118;
  const start = -215; // degrees, 0 = 3 o'clock
  const sweep = 290;
  const split = start + sweep * f;
  const pt = (deg: number, rr = r) => [cx + rr * Math.cos((deg * Math.PI) / 180), cy + rr * Math.sin((deg * Math.PI) / 180)];
  const arc = (a: number, b: number, rr = r) => {
    const [x1, y1] = pt(a, rr), [x2, y2] = pt(b, rr);
    return `M ${x1} ${y1} A ${rr} ${rr} 0 ${b - a > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  return (
    <div className="ring-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          <path id="ring-done" d={arc(start, split, r)} />
          <path id="ring-rest" d={arc(split, start + sweep, r)} />
        </defs>
        <path d={arc(start, start + sweep)} stroke="rgba(255,255,255,.35)" strokeWidth={46} fill="none" strokeLinecap="round" />
        <path d={arc(split, start + sweep)} stroke="#eef5fd" strokeWidth={42} fill="none" strokeLinecap="round" />
        <path d={arc(start, split)} stroke="#0e2347" strokeWidth={46} fill="none" strokeLinecap="round" />
        <text fontSize="13" fontWeight="600" fill="#fff" dy="4.5">
          <textPath href="#ring-done" startOffset="50%" textAnchor="middle">{f > 0.18 ? doneLabel : ""}</textPath>
        </text>
        <text fontSize="13" fontWeight="600" fill="#0b1e3f" dy="4.5">
          <textPath href="#ring-rest" startOffset="50%" textAnchor="middle">{f < 0.82 ? restLabel : ""}</textPath>
        </text>
      </svg>
      <div className="ring-center">
        <div>
          <div className="value">{center}</div>
          <div className="label">{caption}</div>
        </div>
      </div>
    </div>
  );
}
