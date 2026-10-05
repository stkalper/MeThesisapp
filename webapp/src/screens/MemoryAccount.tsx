import { useEffect, useState } from "react";
import { api, type MemoryAccount } from "../api";
import { Icon, Spinner, toast, useLoad } from "../components";
import { date, shortHash } from "../format";
import { haptic, openLink } from "../telegram";

const DASHBOARD = "https://memory.walrus.xyz";

function ConnectSheet({ onDone, onCancel }: { onDone: (a: MemoryAccount) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const account = await api.connectMemory(key, accountId);
      setKey(""); // don't keep the secret in UI state longer than needed
      haptic.success();
      toast("Connected — new memories now go to your own Walrus account");
      onDone(account);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3>Use your own Walrus Memory</h3><span className="spacer" /><button onClick={onCancel} aria-label="Close"><Icon.x /></button></div>
        <ol className="steps">
          <li>
            Open <button className="link-btn" onClick={() => openLink(DASHBOARD)}>memory.walrus.xyz ↗</button> and sign in with your Sui wallet.
          </li>
          <li>Create a <b>new delegate key</b> just for this app — label it “Thesis Keeper”.</li>
          <li>Paste the delegate <b>private key</b> and your <b>Account ID</b> below.</li>
        </ol>
        <div className="form">
          <div className="field">
            <label>Delegate private key</label>
            <input
              className="input hash"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="64 hex characters"
            />
          </div>
          <div className="field">
            <label>Account ID</label>
            <input
              className="input hash"
              autoComplete="off"
              spellCheck={false}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="0x…"
            />
          </div>
          <p className="hint" style={{ lineHeight: 1.5 }}>
            🔒 A delegate key can only read and write Walrus Memory — it can't move funds. We verify it with Walrus,
            store it encrypted, and never show it again. You can revoke it any time on memory.walrus.xyz.
            <b> Never paste your wallet seed phrase.</b>
          </p>
          <button className="btn primary" disabled={busy || !key.trim() || !accountId.trim()} onClick={submit}>
            {busy ? <Spinner /> : null} Verify & connect
          </button>
        </div>
      </div>
    </div>
  );
}

export function MemoryAccountCard() {
  const { data, reload, setData } = useLoad(api.memoryAccount);
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);

  // Poll while history is being copied.
  const running = data?.importJob?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(t);
  }, [running, reload]);

  if (!data) return null;
  const own = data.mode === "user";
  const job = data.importJob;

  async function copyHistory() {
    setBusy(true);
    try {
      setData(await api.importMemory());
      toast("Copying your history to your Walrus account…");
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    try {
      setData(await api.disconnectMemory());
      setConfirmDisconnect(false);
      toast("Disconnected — back to the app's memory. Your data stays in your account.");
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  return (
    <section className="card">
      <div className="card-title">
        Memory account
        <span className={`badge ${own ? "stored" : "local"}`}>{own ? "Yours" : "App default"}</span>
      </div>

      {own ? (
        <>
          <p className="eyebrow" style={{ marginTop: 0, lineHeight: 1.45 }}>
            New memories are written to <b>your</b> Walrus Memory account. They belong to your wallet — not to this app.
          </p>
          <div className="kv">
            <div><span>Account</span><b className="hash">{shortHash(data.accountId)}</b></div>
            <div><span>Owner wallet</span><b className="hash">{shortHash(data.owner)}</b></div>
            <div><span>Namespace</span><b className="hash">{data.namespace}</b></div>
            <div><span>Connected</span><b>{data.connectedAt ? date(data.connectedAt) : "—"}</b></div>
          </div>

          {(data.copyableCount > 0 || job) && (
            <div className="mt">
              {job?.status === "running" ? (
                <p className="hint"><Spinner /> Copying {job.total} memories to your account…</p>
              ) : job?.status === "done" ? (
                <p className="hint">✅ Copied {job.succeeded} of {job.total} memories{job.failed ? ` (${job.failed} failed — try again)` : ""}.</p>
              ) : job?.status === "failed" ? (
                <p className="hint" style={{ color: "var(--down)" }}>Copy failed: {job.error}</p>
              ) : null}
              {data.copyableCount > 0 && job?.status !== "running" && (
                <button className="btn primary mt" disabled={busy} onClick={copyHistory}>
                  {busy ? <Spinner /> : null} Copy my {data.copyableCount} earlier memories here
                </button>
              )}
            </div>
          )}

          <details className="mt portable">
            <summary>Take this memory to another app</summary>
            <p>
              On memory.walrus.xyz, create a delegate key for the other app and give it your Account ID. Any app that
              reads the namespace <b className="hash">{data.namespace}</b> will see the same theses, check-ins and lessons.
            </p>
          </details>

          <button className="btn ghost mt" onClick={() => (confirmDisconnect ? void disconnect() : setConfirmDisconnect(true))}>
            {confirmDisconnect ? "Tap again to disconnect" : "Disconnect my account"}
          </button>
        </>
      ) : (
        <>
          <p className="eyebrow" style={{ marginTop: 0, lineHeight: 1.45 }}>
            Your memories are stored, encrypted, in Thesis Keeper's Walrus Memory account. Want to own them instead?
            Connect your own account and take your trading memory to any app.
          </p>
          <button className="btn mt" onClick={() => setConnecting(true)}>
            <Icon.link /> Use my own Walrus Memory
          </button>
          <p className="hint mt">Optional — everything works without it.</p>
        </>
      )}

      {connecting && (
        <ConnectSheet
          onCancel={() => setConnecting(false)}
          onDone={(a) => {
            setConnecting(false);
            setData(a);
          }}
        />
      )}
    </section>
  );
}
