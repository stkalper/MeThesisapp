import { Bot, InlineKeyboard, type Context } from "grammy";
import { config, walruscanBlobUrl } from "./config.js";
import * as coach from "./coach.js";
import * as journal from "./journal.js";
import { recallFor } from "./memory.js";
import { extractRules } from "./rules.js";
import { computeMetrics } from "./positions.js";
import { getQuotes } from "./prices.js";
import * as store from "./store.js";

const appUrl = () => (config.publicUrl.startsWith("https://") ? config.publicUrl : "");

function openAppKeyboard(label = "Open Thesis Keeper", path = "") {
  const url = appUrl();
  return url ? new InlineKeyboard().webApp(label, `${url}${path}`) : undefined;
}

function rememberUser(ctx: Context): string | undefined {
  const from = ctx.from;
  if (!from) return undefined;
  store.upsertUser({
    id: String(from.id),
    firstName: from.first_name,
    username: from.username,
    languageCode: from.language_code,
    chatId: ctx.chat?.id,
  });
  return String(from.id);
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export function createBot(): Bot | null {
  if (!config.telegram.botToken) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set — bot disabled, API only.");
    return null;
  }
  const bot = new Bot(config.telegram.botToken);

  bot.use(async (ctx, next) => {
    rememberUser(ctx);
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        `Hey ${ctx.from?.first_name ?? "trader"} 👋 I'm Thesis Keeper.`,
        "",
        "Before you open a trade, write down WHY — your thesis, target and invalidation. I store it in your encrypted Walrus Memory, timestamped and tamper-proof.",
        "",
        "Later, when the market makes you want to panic-sell or FOMO in, I'll remind you what you wrote when you were calm — and what happened the last time you broke your own rules.",
        "",
        "• Open the app to add a spot or perp position with a thesis",
        "• Just text me how you feel about a trade — I'll check it against your memory",
        "• /positions — live PnL   • /recall <query> — search your memory",
        "• /note <text> — journal a thought   • /proof — your verifiable track record",
      ].join("\n"),
      { reply_markup: openAppKeyboard() },
    );
  });

  bot.command("help", (ctx) =>
    ctx.reply(
      "/positions — open positions with live PnL\n/recall <query> — semantic search over your Walrus Memory\n/note <text> — save a journal note\n/proof — thesis track record with Walrus proofs\n/reset — clear short-term chat context (long-term memory stays)\n\nOr just write to me.",
      { reply_markup: openAppKeyboard() },
    ),
  );

  bot.command("positions", async (ctx) => {
    const userId = String(ctx.from!.id);
    const mine = store.positionsFor(userId);
    const open = mine.filter((p) => p.status === "open");
    const pending = mine.filter((p) => p.status === "pending");
    if (!open.length && !pending.length) {
      return ctx.reply("No open positions yet. Add one with a thesis in the app.", { reply_markup: openAppKeyboard() });
    }
    const quotes = await getQuotes([...open, ...pending].map((p) => p.symbol));
    const label = (p: (typeof mine)[number]) => `${p.side.toUpperCase()} ${p.symbol}${p.type === "perp" ? ` ${p.leverage}x` : ""}`;
    const lines = open.map((p) => {
      const mark = quotes[p.symbol]?.price;
      if (!mark) return `• ${journal.describePosition(p)} — price n/a`;
      const m = computeMetrics(p, mark);
      return `• ${label(p)} — ${journal.usd(mark)}  ${journal.usd(m.pnl)} (${pct(m.pnlPct)})`;
    });
    if (pending.length) {
      lines.push("", "⏳ Limit orders:");
      for (const p of pending) {
        const mark = quotes[p.symbol]?.price;
        const away = mark ? ` (${pct(((p.entryPrice - mark) / mark) * 100)} away)` : "";
        lines.push(`• ${label(p)} @ ${journal.usd(p.entryPrice)}${away}`);
      }
    }
    await ctx.reply(lines.join("\n"), { reply_markup: openAppKeyboard("Open positions", "/#/positions") });
  });

  bot.command("recall", async (ctx) => {
    const q = ctx.match.trim();
    if (!q) return ctx.reply("Usage: /recall when did I panic sell?");
    await ctx.replyWithChatAction("typing");
    const results = await recallFor(String(ctx.from!.id), q, 5);
    if (!results.length) return ctx.reply("Nothing in your memory matches that yet.");
    await ctx.reply(
      results.map((r) => `• ${r.text}${r.blobId ? `\n  ↳ ${walruscanBlobUrl(r.blobId)}` : ""}`).join("\n\n"),
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("note", async (ctx) => {
    const text = ctx.match.trim();
    if (text.length < 3) return ctx.reply("Usage: /note I keep adding to losers when I'm tired");
    const { stored } = journal.note(String(ctx.from!.id), text);
    void extractRules(String(ctx.from!.id), text, "note");
    const msg = await ctx.reply("Sealing your note on Walrus… ⏳");
    const entry = await stored;
    await ctx.api.editMessageText(
      msg.chat.id,
      msg.message_id,
      entry.memory.status === "stored"
        ? `Saved to Walrus Memory ✅\n${walruscanBlobUrl(entry.memory.blobId!)}`
        : entry.memory.status === "local"
          ? "Saved (local mode)."
          : `Could not store this note: ${entry.memory.error ?? "unknown error"}`,
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("proof", async (ctx) => {
    const positions = store.positionsFor(String(ctx.from!.id)).slice(0, 10);
    if (!positions.length) return ctx.reply("No theses yet.");
    const lines = positions.map((p) => {
      const res = p.exitPrice ? ` → ${pct(computeMetrics(p, p.exitPrice).pnlPct)} (${p.thesisOutcome ?? "?"})` : " (open)";
      const proof = p.proof.blobId ? `\n  ↳ ${walruscanBlobUrl(p.proof.blobId)}` : `\n  ↳ proof: ${p.proof.status}`;
      return `• ${p.openedAt.slice(0, 10)} ${p.side.toUpperCase()} ${p.symbol} @ ${journal.usd(p.entryPrice)}${res}${proof}`;
    });
    await ctx.reply(lines.join("\n"), {
      link_preview_options: { is_disabled: true },
      reply_markup: openAppKeyboard("Open track record", "/#/proof"),
    });
  });

  bot.command("reset", async (ctx) => {
    store.clearChat(String(ctx.from!.id));
    await ctx.reply("Short-term chat context cleared. Your long-term Walrus Memory is untouched.");
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    await ctx.replyWithChatAction("typing");
    try {
      const { reply, memoriesUsed, drift } = await coach.chat(String(ctx.from.id), text);
      // Show what the answer was grounded in, so it's visible that the bot remembers rather than improvises.
      const driftNote = drift.length
        ? `\n\n⚠️ Thesis drift recorded on Walrus: ${drift.map((d) => `${d.symbol} — entered for "${d.original}", now "${d.now}"`).join("; ")}`
        : "";
      await ctx.reply(`${reply || "…"}${driftNote}${coach.memoryReceipt(memoriesUsed)}`.slice(0, 4096));
    } catch (err) {
      console.error("[bot] chat failed:", err);
      await ctx.reply("Something went wrong on my side — try again in a moment.");
    }
  });

  bot.catch((err) => console.error("[bot] error:", err.error));
  return bot;
}

export async function startBot(bot: Bot) {
  await bot.api.setMyCommands([
    { command: "positions", description: "Open positions with live PnL" },
    { command: "recall", description: "Search your Walrus Memory" },
    { command: "note", description: "Journal a thought" },
    { command: "proof", description: "Your verifiable thesis track record" },
    { command: "reset", description: "Clear short-term chat context" },
    { command: "help", description: "How it works" },
  ]);
  const url = appUrl();
  if (url) {
    await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "App", web_app: { url } } });
  } else {
    console.warn("[bot] PUBLIC_URL is not an https URL — Mini App buttons are hidden.");
  }
  void bot.start({ onStart: (me) => console.log(`[bot] @${me.username} is polling`) });
}
