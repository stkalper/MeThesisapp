import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Encrypts user-supplied Walrus Memory delegate keys at rest (AES-256-GCM).
 * The master secret comes from USER_KEY_SECRET; if it's missing, one is generated
 * into the data directory so local setups work — production should set the env var
 * so a leaked data volume alone doesn't expose user keys.
 */

function masterKey(): Buffer {
  let secret = process.env.USER_KEY_SECRET?.trim();
  if (!secret) {
    const file = path.join(config.dataDir, ".user-key-secret");
    try {
      secret = fs.readFileSync(file, "utf8").trim();
    } catch {
      secret = randomBytes(32).toString("hex");
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
      console.warn(`[secrets] USER_KEY_SECRET not set — generated one in ${file}. Set it in the environment for production.`);
    }
  }
  return createHash("sha256").update(secret).digest();
}

let key: Buffer | undefined;
const getKey = () => (key ??= masterKey());

/** Returns "v1:<iv>:<tag>:<ciphertext>" (base64 parts). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
