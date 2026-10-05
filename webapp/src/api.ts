import { tg } from "./telegram";

export type PositionType = "spot" | "perp";
export type Side = "long" | "short";
export type OrderType = "market" | "limit";
export type SizeUnit = "margin" | "usdt" | "token";
export type PositionStatus = "pending" | "open" | "closed" | "cancelled";

export interface Thesis {
  text: string;
  targetPrice?: number;
  invalidationPrice?: number;
  invalidationText?: string;
  horizon?: string;
  conviction: number;
}

export interface Metrics {
  quantity: number;
  invested: number;
  notional: number;
  value: number;
  pnl: number;
  pnlPct: number;
  priceMovePct: number;
  liquidationPrice?: number;
  liquidationProximity?: number;
  liquidated: boolean;
}

export interface Proof {
  hash: string;
  blobId?: string;
  storedAt?: string;
  status: "pending" | "stored" | "failed" | "local";
  error?: string;
}

export interface Position {
  id: string;
  type: PositionType;
  symbol: string;
  side: Side;
  entryPrice: number;
  size: number;
  leverage: number;
  sizeInput?: { unit: SizeUnit; value: number };
  orderType: OrderType;
  placedAt: string;
  refPrice?: number;
  openedAt: string;
  status: PositionStatus;
  cancelledAt?: string;
  distanceToLimitPct?: number;
  commitment?: { hash: string; status: "pending" | "published" | "failed"; network: string; blobId?: string };
  commitmentUrl?: string;
  revealed?: boolean;
  postmortem?: PostMortem;
  closedAt?: string;
  exitPrice?: number;
  exitReason?: string;
  lesson?: string;
  thesisOutcome?: "right" | "wrong" | "partial" | "unclear";
  thesis: Thesis;
  proof: Proof;
  mark?: number;
  change24hPct?: number;
  metrics: Metrics | null;
  proofUrl?: string;
}

export interface JournalEntry {
  id: string;
  positionId?: string;
  kind: "thesis" | "checkin" | "close" | "note" | "chat" | "alert" | "fill" | "cancel" | "rule";
  text: string;
  createdAt: string;
  memory: { status: "pending" | "stored" | "failed" | "local"; blobId?: string; error?: string; space?: "app" | "user" };
  proofUrl?: string;
}

export interface Portfolio {
  invested: number;
  value: number;
  unrealized: number;
  unrealizedPct: number;
  realized: number;
  openCount: number;
  pendingCount: number;
  closedCount: number;
  months: Array<{ month: string; profit: number; loss: number }>;
  memoryCount: number;
  storedOnWalrus: number;
  positions: Position[];
}

export interface Recalled {
  text: string;
  blobId?: string;
  distance: number;
  proofUrl?: string;
}

export interface Insights {
  headline: string;
  patterns: Array<{ title: string; evidence: string; advice: string }>;
  stats: { closed: number; winRate: number | null; thesisAccuracy: number | null; avgHoldDays: number | null; memories: number };
  generatedAt: string;
}

export interface Me {
  user?: { id: string; firstName?: string; username?: string };
  namespace: string;
  memoryMode: "walrus" | "local";
  memorySpace: "app" | "user";
  walrus: boolean;
  network: string;
}

export interface Quote {
  symbol: string;
  price: number;
  change24hPct?: number;
}

export interface ProofRow {
  id: string;
  symbol: string;
  type: PositionType;
  side: Side;
  leverage: number;
  entryPrice: number;
  exitPrice?: number;
  status: PositionStatus;
  orderType: OrderType;
  placedAt: string;
  openedAt: string;
  closedAt?: string;
  thesis: Thesis;
  thesisOutcome?: Position["thesisOutcome"];
  pnlPct?: number;
  proof: Proof;
  proofUrl?: string;
  commitment?: { hash: string; status: "pending" | "published" | "failed"; network: string };
  commitmentUrl?: string;
  revealed: boolean;
}

export interface TradingRule {
  id: string;
  text: string;
  check?: { type: string; value?: number; scope?: string; symbol?: string };
  source: "lesson" | "note" | "chat" | "manual";
  createdAt: string;
}

export interface RuleViolation {
  ruleId: string;
  rule: string;
  detail: string;
}

interface TradeRecord {
  count: number;
  wins: number;
  avgPnlPct: number | null;
  wiped: number;
}

export interface Precheck {
  violations: RuleViolation[];
  similar: Recalled[];
  record: { sameSymbol: TradeRecord; highLeverage: TradeRecord | null };
  summary?: string;
}

export interface PostMortem {
  story: string;
  lesson: string;
  followedPlan: "yes" | "partly" | "no" | "unclear";
  createdAt?: string;
}

export interface PublicThesis {
  id: string;
  payload: string;
  commitment: {
    sha256: string;
    blobId: string;
    objectId?: string;
    registeredEpoch?: number;
    network: string;
    publishedAt?: string;
    aggregatorUrl: string;
    walruscanUrl: string;
    suiObjectUrl?: string;
  };
  status: PositionStatus;
  exitPrice?: number;
  closedAt?: string;
  thesisOutcome?: Position["thesisOutcome"];
  revealedAt?: string;
}

export interface MemoryAccount {
  mode: "app" | "user";
  namespace: string;
  accountId?: string;
  owner?: string;
  publicKey?: string;
  connectedAt?: string;
  copyableCount: number;
  importJob?: { status: "running" | "done" | "failed"; total: number; succeeded: number; failed: number; error?: string };
}

export class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(tg?.initData ? { "X-Telegram-Init-Data": tg.initData } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  me: () => request<Me>("/me"),
  portfolio: () => request<Portfolio>("/portfolio"),
  position: (id: string) => request<{ position: Position; journal: JournalEntry[] }>(`/positions/${id}`),
  createPosition: (body: unknown) => post<{ position: Position }>("/positions", body),
  checkIn: (id: string, feeling: string) => post<{ entry: JournalEntry; reply: string }>(`/positions/${id}/checkin`, { feeling }),
  cancel: (id: string, reason = "") => post<{ position: Position }>(`/positions/${id}/cancel`, { reason }),
  close: (id: string, body: { exitPrice?: number; reason: string; outcome: string; lesson?: string }) =>
    post<{ position: Position }>(`/positions/${id}/close`, body),
  quotes: (symbols: string[]) => request<Record<string, Quote>>(`/quotes?symbols=${symbols.join(",")}`),
  journal: () => request<JournalEntry[]>("/journal"),
  note: (text: string) => post<JournalEntry>("/journal", { text }),
  recall: (q: string) => request<Recalled[]>(`/recall?q=${encodeURIComponent(q)}`),
  chatHistory: () => request<Array<{ role: "user" | "assistant"; content: string; at: string }>>("/chat"),
  chat: (message: string) => post<{ reply: string; memoriesUsed: Recalled[] }>("/chat", { message }),
  insights: (force = false) => request<Insights>(`/insights${force ? "?force=1" : ""}`),
  proof: () => request<ProofRow[]>("/proof"),
  retryCommit: (id: string) => post<{ position: Position }>(`/positions/${id}/commit`, {}),
  review: (id: string, exitPrice?: number) => post<PostMortem>(`/positions/${id}/review`, { exitPrice }),
  reveal: (id: string, reveal: boolean) => post<{ position: Position }>(`/positions/${id}/reveal`, { reveal }),
  publicThesis: (id: string) => request<PublicThesis>(`/public/theses/${id}`),
  precheck: (body: unknown) => post<Precheck>("/positions/precheck", body),
  rules: () => request<TradingRule[]>("/rules"),
  addRule: (text: string) => post<TradingRule>("/rules", { text }),
  deleteRule: (id: string) => post<{ ok: true }>(`/rules/${id}/delete`, {}),
  memoryAccount: () => request<MemoryAccount>("/memory/account"),
  connectMemory: (privateKey: string, accountId: string) => post<MemoryAccount>("/memory/account", { privateKey, accountId }),
  disconnectMemory: () => post<MemoryAccount>("/memory/account/disconnect", {}),
  importMemory: () => post<MemoryAccount>("/memory/import", {}),
};
