import { useEffect, useRef, useState } from "react";
import { api, type Drift, type Recalled } from "../api";
import { DriftCard, Icon, RecallReceipt, toast, TopBar } from "../components";
import { haptic } from "../telegram";

interface Msg {
  role: "user" | "assistant";
  content: string;
  recalled?: Recalled[];
  drift?: Drift[];
}

const SUGGESTIONS = [
  "I want to sell everything, the news looks bad",
  "What was my plan for my biggest position?",
  "What mistakes do I keep repeating?",
  "Should I add leverage here?",
];

export function Coach() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatHistory().then((h) => setMessages(h.map((m) => ({ role: m.role, content: m.content })))).catch(() => {});
  }, []);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [messages, busy]);

  async function send(message = text) {
    const m = message.trim();
    if (!m || busy) return;
    setText("");
    setMessages((cur) => [...cur, { role: "user", content: m }]);
    setBusy(true);
    try {
      const res = await api.chat(m);
      haptic.tap();
      setMessages((cur) => [...cur, { role: "assistant", content: res.reply, recalled: res.memoriesUsed, drift: res.drift }]);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in">
      <TopBar />
      <div className="chat">
        <div className="bubble assistant">
          I'm your thesis coach. Tell me what you're tempted to do — I'll check it against what you wrote when you were calm.
        </div>
        {!messages.length && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => <button key={s} className="chip light" onClick={() => void send(s)}>{s}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: "contents" }}>
            {m.drift?.map((d) => <DriftCard key={d.positionId} drift={d} />)}
            {m.recalled && <RecallReceipt memories={m.recalled} />}
            <div className={`bubble ${m.role}`}>{m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="bubble assistant"><span className="typing"><i /><i /><i /></span></div>
        )}
        <div ref={end} />
      </div>

      <div className="composer">
        <textarea
          rows={1}
          value={text}
          placeholder="How are you feeling about your trades?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send" disabled={!text.trim() || busy} onClick={() => void send()} aria-label="Send"><Icon.send /></button>
      </div>
    </div>
  );
}
