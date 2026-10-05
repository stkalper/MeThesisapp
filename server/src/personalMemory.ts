import { forgetPersonalClient, memoryFor, PERSONAL_NAMESPACE, verifyPersonalAccount } from "./memory.js";
import { encryptSecret } from "./secrets.js";
import * as store from "./store.js";

/**
 * "Bring your own Walrus Memory" — optional.
 *
 * By default a user's memories live in the app's Walrus Memory account. A user can instead
 * connect their own account by pasting a delegate key created at memory.walrus.xyz. From then
 * on every new memory is written to *their* account, under the namespace `thesis-keeper`,
 * so any other app they authorise (with its own delegate key) can read the same history.
 * Their existing history can be copied over, and disconnecting leaves their data in their account.
 */

export class PersonalMemoryError extends Error {}

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/u;

export interface ImportJob {
  status: "running" | "done" | "failed";
  total: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

const importJobs = new Map<string, ImportJob>();

export function status(userId: string) {
  const user = store.getUser(userId);
  const m = user?.memwal;
  const appEntries = copyable(userId);
  return {
    mode: m ? ("user" as const) : ("app" as const),
    namespace: memoryFor(userId).namespace,
    accountId: m?.accountId,
    owner: m?.owner,
    publicKey: m?.publicKey,
    connectedAt: m?.connectedAt,
    /** Memories still sitting in the app's account that could be copied to the personal one. */
    copyableCount: appEntries.length,
    importJob: importJobs.get(userId),
  };
}

/** App-account memories not yet copied to the user's own account. */
const copyable = (userId: string) =>
  store
    .journalFor(userId)
    .filter((j) => (j.memory.space ?? "app") === "app" && j.memory.status === "stored" && !j.memory.copiedToUser);

export async function connect(userId: string, rawKey: string, rawAccountId: string) {
  const key = rawKey.trim().replace(/^0x/u, "");
  const accountId = rawAccountId.trim().toLowerCase();
  if (!HEX64.test(key)) {
    throw new PersonalMemoryError("The delegate private key should be 64 hex characters (from memory.walrus.xyz).");
  }
  if (!/^0x[0-9a-f]{64}$/u.test(accountId)) {
    throw new PersonalMemoryError("The account ID should look like 0x followed by 64 hex characters.");
  }

  let verified: Awaited<ReturnType<typeof verifyPersonalAccount>>;
  try {
    verified = await verifyPersonalAccount(key, accountId);
  } catch (err) {
    const msg = (err as Error).message;
    throw new PersonalMemoryError(
      /401/u.test(msg)
        ? "Walrus Memory rejected this key: check that the key is registered on this account and that it's a mainnet account."
        : `Could not reach Walrus Memory: ${msg.slice(0, 120)}`,
    );
  }
  if (verified.accountId && verified.accountId.toLowerCase() !== accountId) {
    throw new PersonalMemoryError("This key belongs to a different Walrus Memory account.");
  }

  store.setUserMemwal(userId, {
    accountId,
    keyCipher: encryptSecret(key),
    publicKey: verified.publicKey,
    owner: verified.owner,
    namespace: PERSONAL_NAMESPACE,
    connectedAt: new Date().toISOString(),
  });
  forgetPersonalClient(userId);
  return status(userId);
}

export function disconnect(userId: string) {
  store.setUserMemwal(userId, undefined);
  forgetPersonalClient(userId);
  importJobs.delete(userId);
  return status(userId);
}

/** Copies the user's history from the app's account into their personal one, in the background. */
export function startImport(userId: string) {
  const target = memoryFor(userId);
  if (target.space !== "user") throw new PersonalMemoryError("Connect your own Walrus Memory account first.");
  if (importJobs.get(userId)?.status === "running") return status(userId);

  // The journal keeps the exact text of every memory, so history can be re-written verbatim.
  const entries = copyable(userId).reverse(); // oldest first
  const texts = entries.map((j) => j.text);
  if (!texts.length) throw new PersonalMemoryError("Everything is already in your own Walrus Memory account.");

  const job: ImportJob = { status: "running", total: texts.length, succeeded: 0, failed: 0, startedAt: new Date().toISOString() };
  importJobs.set(userId, job);

  const backend = target.backend as { rememberMany?: (ns: string, t: string[]) => Promise<{ succeeded: number; failed: number }> };
  void (backend.rememberMany ? backend.rememberMany(target.namespace, texts) : Promise.reject(new Error("unsupported")))
    .then((r) => {
      Object.assign(job, { status: "done", ...r });
      // Walrus Memory remember() always appends, so mark what was copied to avoid duplicates on retry.
      if (r.failed === 0) for (const j of entries) store.updateJournal(j.id, { memory: { ...j.memory, copiedToUser: true } });
    })
    .catch((err: Error) => Object.assign(job, { status: "failed", error: err.message.slice(0, 200) }))
    .finally(() => (job.finishedAt = new Date().toISOString()));

  return status(userId);
}
