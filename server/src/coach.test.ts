import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryReceipt, receiptLine } from "./coach.js";

test("receipt line shows kind, short date and the sentence", () => {
  const line = receiptLine("[THESIS] 2026-10-04 14:36 UTC · Opened LONG BTC perp @ $78,000 (margin $500, 5x).");
  assert.equal(line, "Thesis · Oct 4 — Opened LONG BTC perp @ $78,000 (margin $500, 5x).");
});

test("receipt line handles dashed tags and truncates long bodies", () => {
  const line = receiptLine(`[CHECK-IN] 2026-01-09 09:12 UTC · ${"x".repeat(200)}`, 20);
  assert.ok(line.startsWith("Check-in · Jan 9 — "));
  assert.ok(line.endsWith("…"));
  assert.equal(line.length, "Check-in · Jan 9 — ".length + 20);
});

test("untagged facts from analyze() pass through", () => {
  assert.equal(receiptLine("User never uses more than 5x leverage."), "User never uses more than 5x leverage.");
});

test("receipt footer lists at most three memories and is empty without memories", () => {
  assert.equal(memoryReceipt([]), "");
  const memories = ["a", "b", "c", "d"].map((t) => ({ text: t, distance: 0.1 }));
  const footer = memoryReceipt(memories);
  assert.ok(footer.includes("Recalled from your Walrus Memory"));
  assert.equal(footer.split("\n• ").length - 1, 3);
});

test("language instruction names Ukrainian explicitly, and falls back for Latin text", async () => {
  const { languageInstruction } = await import("./llm.js");
  assert.match(languageInstruction("Тримаю далі, теза в силі"), /in Ukrainian/);
  assert.match(languageInstruction("Держу дальше, всё ещё верю"), /in Russian/);
  assert.match(languageInstruction("I am still holding"), /same language/);
});
