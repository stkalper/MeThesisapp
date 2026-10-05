import { createHash, randomBytes } from "node:crypto";
import * as store from "./store.js";
import type { Commitment, Position } from "./types.js";

/**
 * Commit–reveal "Proof of Thesis".
 *
 * Private theses live encrypted in Walrus Memory, so an outsider can see that a blob existed
 * but not what it said. To make a track record verifiable by anyone, every thesis also gets a
 * PUBLIC commitment: a tiny plaintext Walrus blob holding only sha256(reveal payload).
 * The payload contains a random salt (so short theses can't be brute-forced) and no user ID.
 *
 * Later the user may "reveal": the exact payload is published on a verify page, anyone can
 * recompute its sha256 and compare it with the commitment blob, whose on-chain registration
 * dates it to before the price move.
 *
 * Walrus mainnet has no free public publisher, so commitments go to Walrus TESTNET's public
 * publisher by default (override with WALRUS_PUBLISHER_URL / WALRUS_AGGREGATOR_URL).
 */

const PUBLISHER = (process.env.WALRUS_PUBLISHER_URL ?? "https://publisher.walrus-testnet.walrus.space").replace(/\/$/u, "");
const AGGREGATOR = (process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-testnet.walrus.space").replace(/\/$/u, "");
export const COMMIT_NETWORK = process.env.WALRUS_COMMIT_NETWORK ?? (PUBLISHER.includes("testnet") ? "testnet" : "mainnet");
/** Testnet caps storage at ~53 epochs (≈53 days); fall back to shorter terms if refused. */
const EPOCH_TRIES = [53, 30, 10];

export const aggregatorBlobUrl = (blobId: string) => `${AGGREGATOR}/v1/blobs/${blobId}`;
export const walruscanUrl = (blobId: string) => `https://walruscan.com/${COMMIT_NETWORK}/blob/${blobId}`;
export const suiObjectUrl = (objectId: string) => `https://suiscan.xyz/${COMMIT_NETWORK}/object/${objectId}`;

/**
 * The exact bytes that get hashed and, on reveal, published. Key order is fixed here,
 * and the string itself is what we store and serve, so verification never depends on re-serialising.
 */
export function revealPayload(p: Position, salt: string): string {
  return JSON.stringify({
    app: "thesis-keeper",
    v: 1,
    symbol: p.symbol,
    type: p.type,
    side: p.side,
    orderType: p.orderType,
    entryPrice: p.entryPrice,
    leverage: p.leverage,
    placedAt: p.placedAt,
    thesis: p.thesis,
    salt,
  });
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Prepares the commitment synchronously so its hash can go into the private memory text too. */
export function prepareCommitment(p: Position): Commitment {
  const salt = randomBytes(16).toString("hex");
  const payload = revealPayload(p, salt);
  return { hash: sha256(payload), salt, payload, network: COMMIT_NETWORK, status: "pending" };
}

interface PublisherResponse {
  newlyCreated?: { blobObject: { id: string; blobId: string; registeredEpoch: number; storage?: { endEpoch: number } } };
  alreadyCertified?: { blobId: string; endEpoch?: number; event?: { txDigest?: string } };
}

/** Publishes `{sha256, committedAt}` as a public Walrus blob and records the result on the position. */
export async function publishCommitment(positionId: string, c: Commitment): Promise<Commitment> {
  const body = JSON.stringify({ app: "thesis-keeper", kind: "thesis-commitment", v: 1, sha256: c.hash, committedAt: new Date().toISOString() });
  let last = "";
  for (const epochs of EPOCH_TRIES) {
    try {
      const res = await fetch(`${PUBLISHER}/v1/blobs?epochs=${epochs}`, { method: "PUT", body, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) {
        last = `${res.status} ${text.slice(0, 160)}`;
        if (/EInvalidEpochsAhead/u.test(text)) continue;
        break;
      }
      const json = JSON.parse(text) as PublisherResponse;
      const created = json.newlyCreated?.blobObject;
      const done: Commitment = {
        ...c,
        status: "published",
        blobId: created?.blobId ?? json.alreadyCertified?.blobId,
        objectId: created?.id,
        registeredEpoch: created?.registeredEpoch,
        endEpoch: created?.storage?.endEpoch ?? json.alreadyCertified?.endEpoch,
        publishedAt: new Date().toISOString(),
      };
      store.updatePosition(positionId, { commitment: done });
      return done;
    } catch (err) {
      last = (err as Error).message;
    }
  }
  const failed: Commitment = { ...c, status: "failed", error: last.slice(0, 200) };
  store.updatePosition(positionId, { commitment: failed });
  console.error(`[commitment] publish failed for ${positionId}: ${last}`);
  return failed;
}

/** What the public verify page receives. Only for positions the owner chose to reveal. */
export function publicView(p: Position) {
  const c = p.commitment;
  if (!p.revealed || !c?.blobId) return undefined;
  return {
    id: p.id,
    payload: c.payload,
    commitment: {
      sha256: c.hash,
      blobId: c.blobId,
      objectId: c.objectId,
      registeredEpoch: c.registeredEpoch,
      network: c.network,
      publishedAt: c.publishedAt,
      aggregatorUrl: aggregatorBlobUrl(c.blobId),
      walruscanUrl: walruscanUrl(c.blobId),
      suiObjectUrl: c.objectId ? suiObjectUrl(c.objectId) : undefined,
    },
    status: p.status,
    exitPrice: p.exitPrice,
    closedAt: p.closedAt,
    thesisOutcome: p.thesisOutcome,
    revealedAt: p.revealedAt,
  };
}
