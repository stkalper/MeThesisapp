import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePositionInput, ValidationError } from "./journal.js";

const thesis = { text: "Supply squeeze into Q4 as reserves fall", conviction: 3 };

test("accepts comma decimals and spaces from mobile keyboards", () => {
  const input = validatePositionInput({
    type: "spot",
    symbol: "sui",
    entryPrice: "1,05",
    size: " 1 200 ",
    thesis: { ...thesis, targetPrice: "2,5", invalidationPrice: "$0,85" },
  });
  assert.equal(input.symbol, "SUI");
  assert.equal(input.entryPrice, 1.05);
  assert.equal(input.size, 1200);
  assert.equal(input.thesis.targetPrice, 2.5);
  assert.equal(input.thesis.invalidationPrice, 0.85);
});

test("rejects missing size and short thesis", () => {
  assert.throws(
    () => validatePositionInput({ type: "perp", symbol: "BTC", entryPrice: "80000", size: "", thesis: { text: "pump" } }),
    (err: unknown) => err instanceof ValidationError && /size/.test(err.message) && /thesis/.test(err.message),
  );
});
