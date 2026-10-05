import { test } from "node:test";
import assert from "node:assert/strict";

process.env.USER_KEY_SECRET = "test-secret";
const { decryptSecret, encryptSecret } = await import("./secrets.js");
const personal = await import("./personalMemory.js");

test("delegate keys round-trip through AES-GCM and are not stored in plain text", () => {
  const key = "ab".repeat(32);
  const sealed = encryptSecret(key);
  assert.ok(!sealed.includes(key));
  assert.notEqual(encryptSecret(key), sealed, "random IV per encryption");
  assert.equal(decryptSecret(sealed), key);
});

test("tampered ciphertext is rejected", () => {
  const sealed = encryptSecret("cd".repeat(32));
  const parts = sealed.split(":");
  parts[3] = Buffer.from("tampered!").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":")));
});

test("connect rejects malformed keys before calling Walrus", async () => {
  await assert.rejects(personal.connect("u1", "not-a-key", "0x" + "1".repeat(64)), personal.PersonalMemoryError);
  await assert.rejects(personal.connect("u1", "ab".repeat(32), "0x123"), personal.PersonalMemoryError);
});
