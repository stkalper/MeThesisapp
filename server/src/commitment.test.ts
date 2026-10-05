import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareCommitment, publicView, revealPayload, sha256 } from "./commitment.js";
import type { Position } from "./types.js";

const position: Position = {
  id: "p1",
  userId: "123456789",
  type: "perp",
  symbol: "BTC",
  side: "long",
  entryPrice: 80000,
  size: 100,
  leverage: 5,
  orderType: "market",
  placedAt: "2026-10-04T10:00:00.000Z",
  openedAt: "2026-10-04T10:00:00.000Z",
  status: "open",
  thesis: { text: "ETF inflows", conviction: 3 },
  proof: { hash: "h", status: "stored" },
  alertsSent: [],
};

test("the public payload never contains the Telegram user id", () => {
  const c = prepareCommitment(position);
  assert.ok(!c.payload.includes(position.userId));
  assert.equal(JSON.parse(c.payload).thesis.text, "ETF inflows");
});

test("hash is sha256 of the exact payload and salted per thesis", () => {
  const a = prepareCommitment(position);
  const b = prepareCommitment(position);
  assert.equal(a.hash, sha256(a.payload));
  assert.notEqual(a.hash, b.hash, "random salt → different commitment for identical theses");
  assert.equal(revealPayload(position, a.salt), a.payload, "payload is reproducible from salt");
});

test("nothing is public until the owner reveals", () => {
  const c = { ...prepareCommitment(position), status: "published" as const, blobId: "blob" };
  assert.equal(publicView({ ...position, commitment: c }), undefined);
  assert.equal(publicView({ ...position, commitment: c, revealed: true })?.payload, c.payload);
});
