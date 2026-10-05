export type PositionType = "spot" | "perp";
export type Side = "long" | "short";
export type OrderType = "market" | "limit";
/** pending = limit order waiting for its price; cancelled = limit order withdrawn before filling */
export type PositionStatus = "pending" | "open" | "closed" | "cancelled";

export interface Thesis {
  /** Why the user is entering — the core claim. */
  text: string;
  /** Price at which the thesis is considered played out (optional). */
  targetPrice?: number;
  /** Price at which the thesis is considered wrong. */
  invalidationPrice?: number;
  /** Non-price invalidation, e.g. "ETF flows turn negative for 2 weeks". */
  invalidationText?: string;
  /** Expected holding horizon, free-form ("2 weeks", "6 months"). */
  horizon?: string;
  /** 1–5 */
  conviction: number;
}

/** On-chain proof that the thesis existed at a given time. */
export interface Proof {
  /** sha256 of the canonical thesis payload, embedded in the stored memory text. */
  hash: string;
  blobId?: string;
  memoryId?: string;
  storedAt?: string;
  status: "pending" | "stored" | "failed" | "local";
  error?: string;
}

export interface PostMortem {
  story: string;
  lesson: string;
  followedPlan: "yes" | "partly" | "no" | "unclear";
  createdAt: string;
  journalId?: string;
}

/** Public commit–reveal proof (see commitment.ts). */
export interface Commitment {
  /** sha256 of `payload` — the only thing published until the user reveals. */
  hash: string;
  salt: string;
  /** Exact JSON string that was hashed; published on reveal. */
  payload: string;
  network: string;
  status: "pending" | "published" | "failed";
  blobId?: string;
  /** Sui object of the blob — its creation transaction dates the commitment. */
  objectId?: string;
  registeredEpoch?: number;
  endEpoch?: number;
  publishedAt?: string;
  error?: string;
}

export interface Position {
  id: string;
  userId: string;
  type: PositionType;
  /** Base asset, upper-case, e.g. "BTC" */
  symbol: string;
  side: Side;
  /** For limit orders this is the limit price; it becomes the fill price. */
  entryPrice: number;
  /** spot: quantity of the asset; perp: margin in USD */
  size: number;
  /** perp only, 1 for spot */
  leverage: number;
  /** How the user entered the size, for display: "250 USDT" vs "0.1 BTC". */
  sizeInput?: { unit: "margin" | "usdt" | "token"; value: number };
  orderType: OrderType;
  /** When the thesis was written (and sealed). Never changes — part of the proof hash. */
  placedAt: string;
  /** Market price when a limit order was placed; tells which way the price must cross to fill. */
  refPrice?: number;
  /** Fill time. Equals placedAt for market positions; for limit orders it is overwritten on fill. */
  openedAt: string;
  status: PositionStatus;
  cancelledAt?: string;
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  lesson?: string;
  /** Did the thesis play out? Answered on close. */
  thesisOutcome?: "right" | "wrong" | "partial" | "unclear";
  thesis: Thesis;
  proof: Proof;
  /** Alerts already sent, so the monitor does not spam. */
  alertsSent: string[];
  /** Own rules the user knowingly broke when opening this position. */
  ruleViolations?: RuleViolation[];
  commitment?: Commitment;
  /** AI-written story of the trade, generated from its memories after close. */
  postmortem?: PostMortem;
  /** The owner chose to publish the thesis on the public verify page. */
  revealed?: boolean;
  revealedAt?: string;
}

export type JournalKind = "thesis" | "checkin" | "close" | "note" | "chat" | "alert" | "fill" | "cancel" | "rule" | "postmortem" | "drift";

export interface JournalEntry {
  id: string;
  userId: string;
  positionId?: string;
  kind: JournalKind;
  /** The exact text written to Walrus Memory. */
  text: string;
  createdAt: string;
  memory: {
    status: "pending" | "stored" | "failed" | "local";
    blobId?: string;
    error?: string;
    /** Missing on entries written before personal accounts existed (= "app"). */
    space?: MemorySpace;
    /** An "app" memory that has already been copied into the user's personal account. */
    copiedToUser?: boolean;
  };
}

export interface User {
  id: string;
  firstName?: string;
  username?: string;
  languageCode?: string;
  chatId?: number;
  createdAt: string;
  /** Optional: the user's own Walrus Memory account. When set, their memories live there instead of the app's. */
  memwal?: UserMemwal;
}

export interface UserMemwal {
  accountId: string;
  /** Delegate private key, AES-256-GCM encrypted (see secrets.ts). Never sent to the client. */
  keyCipher: string;
  publicKey: string;
  /** Sui address that owns the account, as reported by the relayer. */
  owner?: string;
  namespace: string;
  connectedAt: string;
}

/** Which Walrus Memory account a memory was written to. */
export type MemorySpace = "app" | "user";

/** A machine-checkable part of a rule. Rules without one are shown as reminders only. */
export type RuleCheck =
  | { type: "maxLeverage"; value: number; scope: "all" | "alts" | "btc-eth" }
  | { type: "maxMarginUsd"; value: number }
  | { type: "requireInvalidation" }
  | { type: "minRiskReward"; value: number }
  | { type: "avoidSymbol"; symbol: string }
  | { type: "noShorts" };

export interface TradingRule {
  id: string;
  userId: string;
  /** The rule in the user's own words, e.g. "Never more than 5x on altcoins". */
  text: string;
  check?: RuleCheck;
  source: "lesson" | "note" | "chat" | "manual";
  /** Journal entry that holds the [RULE] memory on Walrus. */
  journalId?: string;
  createdAt: string;
}

export interface RuleViolation {
  ruleId: string;
  rule: string;
  detail: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}
