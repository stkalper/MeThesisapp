import fs from "node:fs";
import path from "node:path";
import { MemWal } from "@mysten-incubation/memwal";
import { config, memwalEnabled } from "./config.js";
import { decryptSecret } from "./secrets.js";
import * as store from "./store.js";
import type { MemorySpace, UserMemwal } from "./types.js";

/**
 * Thin wrapper around Walrus Memory.
 *
 * Two kinds of memory space:
 *  - default: the app's Walrus Memory account, one namespace per Telegram user
 *    (`${prefix}:tg:${telegramId}`). Walrus Memory isolates namespaces at the relayer
 *    (SQL `WHERE namespace = $1`), so one user's theses never surface in another's recall.
 *  - optional: the user's OWN Walrus Memory account (they paste a delegate key + account ID).
 *    Memories then belong to their wallet, under the portable namespace `thesis-keeper`,
 *    and any other app they give a delegate key to can read the same history.
 *
 * When credentials are missing (local development) a keyword-matching local store
 * is used instead, so the app still runs — the UI clearly labels such memories "local".
 */

export interface RecalledMemory {
  text: string;
  blobId?: string;
  distance: number;
}

export interface StoredMemory {
  blobId?: string;
  memoryId?: string;
  mode: "walrus" | "local";
}

export interface AnalyzedFact {
  text: string;
  blobId?: string;
  ok: boolean;
}

export interface MemoryBackend {
  readonly mode: "walrus" | "local";
  remember(namespace: string, text: string): Promise<StoredMemory>;
  recall(namespace: string, query: string, limit?: number): Promise<RecalledMemory[]>;
  /** Let Walrus Memory extract durable facts from free-form chat and store each one. */
  analyze(namespace: string, text: string): Promise<AnalyzedFact[]>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Recall results above this distance are usually unrelated filler (see Walrus Memory docs). */
const MAX_DISTANCE = 0.8;

class WalrusMemory implements MemoryBackend {
  readonly mode = "walrus" as const;
  private client: MemWal;

  constructor(creds = { key: config.memwal.key, accountId: config.memwal.accountId }) {
    this.client = MemWal.create({
      key: creds.key,
      accountId: creds.accountId,
      serverUrl: config.memwal.serverUrl,
      namespace: config.memwal.namespacePrefix,
    });
  }

  /** Resolves which account/owner this delegate key authenticates as; throws on 401. */
  async whoami(): Promise<{ accountId: string; owner: string }> {
    // `/api/whoami` isn't wrapped by the SDK yet; reuse its request signer.
    const signed = (this.client as unknown as { signedRequest: (...a: unknown[]) => Promise<Record<string, string>> })
      .signedRequest;
    const res = await signed.call(this.client, "GET", "/api/whoami", undefined, [200], { includeDelegateKey: false });
    return { accountId: res.account_id ?? "", owner: res.owner ?? "" };
  }

  async publicKey(): Promise<string> {
    return this.client.getPublicKeyHex();
  }

  /** Bulk write (max 20 per relayer call) — used to copy history into a personal account. */
  async rememberMany(namespace: string, texts: string[]): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20).map((text) => ({ text, namespace }));
      const res = await this.client.rememberBulkAndWait(batch, { timeoutMs: 180_000 });
      succeeded += res.succeeded;
      failed += res.failed;
    }
    return { succeeded, failed };
  }

  async remember(namespace: string, text: string): Promise<StoredMemory> {
    const result = await this.client.rememberAndWait(text, namespace, { timeoutMs: 60_000 });
    return { blobId: result.blob_id, memoryId: result.id, mode: "walrus" };
  }

  async recall(namespace: string, query: string, limit = 8): Promise<RecalledMemory[]> {
    const result = await this.client.recall({ query, limit, namespace, maxDistance: MAX_DISTANCE });
    return result.results.map((r) => ({ text: r.text, blobId: r.blob_id, distance: r.distance }));
  }

  async analyze(namespace: string, text: string): Promise<AnalyzedFact[]> {
    const result = await this.client.analyzeAndWait(text, namespace, { timeoutMs: 60_000 });
    const byId = new Map(result.results.map((r) => [r.id, r]));
    return result.facts.map((f) => {
      const stored = byId.get(f.id);
      return { text: f.text, blobId: stored?.blob_id ?? f.blob_id, ok: stored ? stored.status === "done" : Boolean(f.blob_id) };
    });
  }

  async health() {
    try {
      const h = await this.client.health();
      return { ok: h.status === "ok" || h.status === "healthy", detail: `${h.status} (relayer ${h.version})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

interface LocalRecord {
  namespace: string;
  text: string;
  at: string;
}

class LocalMemory implements MemoryBackend {
  readonly mode = "local" as const;
  private file = path.join(config.dataDir, "local-memories.json");
  private records: LocalRecord[];

  constructor() {
    try {
      this.records = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.records = [];
    }
  }

  private save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
  }

  async remember(namespace: string, text: string): Promise<StoredMemory> {
    this.records.push({ namespace, text, at: new Date().toISOString() });
    this.save();
    return { mode: "local" };
  }

  async recall(namespace: string, query: string, limit = 8): Promise<RecalledMemory[]> {
    const terms = tokenize(query);
    return this.records
      .filter((r) => r.namespace === namespace)
      .map((r) => {
        const words = new Set(tokenize(r.text));
        const hits = terms.filter((t) => words.has(t)).length;
        return { text: r.text, distance: terms.length ? 1 - hits / terms.length : 1 };
      })
      .filter((r) => r.distance < 1)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async analyze(namespace: string, text: string): Promise<AnalyzedFact[]> {
    if (text.trim().length < 25) return [];
    const fact = `User said: ${text.trim()}`;
    await this.remember(namespace, fact);
    return [{ text: fact, ok: true }];
  }

  async health() {
    return { ok: true, detail: "local fallback (set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID to use Walrus)" };
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}$]+/u)
    .filter((w) => w.length > 2);
}

/** The app's own memory account (or the local fallback in development). */
export const memory: MemoryBackend = memwalEnabled ? new WalrusMemory() : new LocalMemory();

/** Namespace for a user inside the app's shared account. */
export const namespaceFor = (userId: string): string => `${config.memwal.namespacePrefix}:tg:${userId}`;

/** Namespace used inside a user's personal account — short and stable so other apps can find it. */
export const PERSONAL_NAMESPACE = config.memwal.namespacePrefix;

// ---- per-user routing ----

export interface UserMemory {
  backend: MemoryBackend;
  namespace: string;
  space: MemorySpace;
}

const personalClients = new Map<string, { keyCipher: string; client: WalrusMemory }>();

function personalClient(userId: string, m: UserMemwal): WalrusMemory {
  const cached = personalClients.get(userId);
  if (cached && cached.keyCipher === m.keyCipher) return cached.client;
  const client = new WalrusMemory({ key: decryptSecret(m.keyCipher), accountId: m.accountId });
  personalClients.set(userId, { keyCipher: m.keyCipher, client });
  return client;
}

/** Where this user's memories live right now. */
export function memoryFor(userId: string): UserMemory {
  const m = store.getUser(userId)?.memwal;
  if (m) return { backend: personalClient(userId, m), namespace: m.namespace, space: "user" };
  return { backend: memory, namespace: namespaceFor(userId), space: "app" };
}

export function forgetPersonalClient(userId: string) {
  personalClients.delete(userId);
}

export const rememberFor = (userId: string, text: string) => {
  const { backend, namespace, space } = memoryFor(userId);
  return backend.remember(namespace, text).then((stored) => ({ ...stored, space }));
};

export async function recallFor(userId: string, query: string, limit = 8): Promise<RecalledMemory[]> {
  const target = memoryFor(userId);
  const own = target.backend.recall(target.namespace, query, limit);
  // Until the user copies their history over, keep searching what's still in the app's account.
  const leftBehind =
    target.space === "user" &&
    store.journalFor(userId).some((j) => (j.memory.space ?? "app") === "app" && j.memory.status === "stored" && !j.memory.copiedToUser);
  if (!leftBehind) return own;
  const [mine, old] = await Promise.allSettled([own, memory.recall(namespaceFor(userId), query, limit)]);
  if (mine.status === "rejected") throw mine.reason;
  return [...mine.value, ...(old.status === "fulfilled" ? old.value : [])]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

export const analyzeFor = (userId: string, text: string) => {
  const { backend, namespace, space } = memoryFor(userId);
  return backend.analyze(namespace, text).then((facts) => ({ facts, space, mode: backend.mode }));
};

/** Checks a pasted delegate key against the relayer before we store it. */
export async function verifyPersonalAccount(key: string, accountId: string) {
  const client = new WalrusMemory({ key, accountId });
  const who = await client.whoami();
  return { ...who, publicKey: await client.publicKey(), client };
}

export { WalrusMemory };
