import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInitData } from "./telegramAuth.js";

const TOKEN = "123456:TEST-token";

function sign(fields: Record<string, string>): string {
  const dcs = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("accepts correctly signed init data", () => {
  const user = JSON.stringify({ id: 42, first_name: "Ana" });
  const data = sign({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user });
  assert.equal(verifyInitData(data, TOKEN)?.id, 42);
});

test("rejects tampered or expired data", () => {
  const user = JSON.stringify({ id: 42 });
  const data = sign({ auth_date: String(Math.floor(Date.now() / 1000)), user });
  assert.equal(verifyInitData(data.replace("42", "43"), TOKEN), null);
  assert.equal(verifyInitData(data, "other:token"), null);
  const old = sign({ auth_date: String(Math.floor(Date.now() / 1000) - 3 * 86400), user });
  assert.equal(verifyInitData(old, TOKEN), null);
});
