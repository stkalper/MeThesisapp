import type { Bot } from "grammy";
import { config, walruscanBlobUrl } from "./config.js";
import { alertMessage } from "./coach.js";
import { describePosition, fillOrder, liquidatePosition, remember, usd } from "./journal.js";
import { crossedLevels, limitReached, liquidationExit } from "./positions.js";
import { writePostMortem } from "./postmortem.js";
import { getQuotes } from "./prices.js";
import * as store from "./store.js";
import type { Position } from "./types.js";

/**
 * Every tick:
 *  1. fills pending limit orders whose price was reached, and tells the user — with their thesis;
 *  2. watches open positions and, when a thesis level is crossed, sends a reminder
 *     built from the user's own Walrus Memory. Each event fires once per position;
 *  3. closes perps that reached their liquidation price, as an exchange would, and writes the
 *     outcome and post-mortem back to Walrus Memory.
 */
export function startMonitor(bot: Bot) {
  const chatFor = (p: Position) => store.getUser(p.userId)?.chatId ?? Number(p.userId);

  const tick = async () => {
    const pending = store.pendingOrders();
    const open = store.openPositions();
    if (!pending.length && !open.length) return;
    const quotes = await getQuotes([...pending, ...open].map((p) => p.symbol)).catch(
      () => ({}) as Record<string, { price: number }>,
    );

    for (const p of pending) {
      const mark = quotes[p.symbol]?.price;
      if (!mark || !limitReached(p, mark)) continue;
      fillOrder(p, mark);
      const proof = p.proof.blobId ? `\n\nThesis sealed on ${p.placedAt.slice(0, 10)}: ${walruscanBlobUrl(p.proof.blobId)}` : "";
      await bot.api
        .sendMessage(
          chatFor(p),
          `✅ Limit order filled: ${describePosition(p)} is now open (market ${usd(mark)}).\n\n` +
            `Your thesis: “${p.thesis.text}”` +
            (p.thesis.invalidationPrice ? `\nYou're wrong below/above ${usd(p.thesis.invalidationPrice)}.` : "") +
            proof,
          { link_preview_options: { is_disabled: true } },
        )
        .catch((err) => console.error(`[monitor] fill notice for ${p.id} failed:`, (err as Error).message));
    }

    for (const p of open) {
      const mark = quotes[p.symbol]?.price;
      if (!mark) continue;
      const fresh = crossedLevels(p, mark).filter((e) => !p.alertsSent.includes(e));
      for (const event of fresh) {
        store.updatePosition(p.id, { alertsSent: [...p.alertsSent, event] });
        try {
          const text = await alertMessage(p, event, mark);
          await bot.api.sendMessage(chatFor(p), text);
          await remember(p.userId, "alert", `[ALERT] ${new Date().toISOString().slice(0, 16)} UTC · ${p.symbol} ${event} at ${usd(mark)}.`, p.id);
        } catch (err) {
          console.error(`[monitor] alert ${event} for ${p.id} failed:`, (err as Error).message);
        }
      }

      const current = store.getPosition(p.id);
      const exit = current?.status === "open" ? liquidationExit(current, mark) : null;
      if (current && exit) {
        await liquidatePosition(current, exit);
        void writePostMortem(current.id);
        await bot.api
          .sendMessage(
            chatFor(current),
            `💥 ${describePosition(current)} was liquidated at ${usd(exit)} and closed: the whole margin (${usd(current.size)}) is lost.\n\n` +
              `The outcome is saved to your Walrus Memory, and a post-mortem of the trade will appear on the position in a minute.`,
          )
          .catch((err) => console.error(`[monitor] liquidation notice for ${p.id} failed:`, (err as Error).message));
      }
    }
  };
  const timer = setInterval(() => void tick(), config.monitorIntervalMs);
  void tick();
  return () => clearInterval(timer);
}
