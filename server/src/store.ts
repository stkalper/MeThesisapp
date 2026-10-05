import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { ChatMessage, JournalEntry, Position, TradingRule, User } from "./types.js";

/**
 * Small JSON-file store for structured app state (users, positions, journal index).
 * The *meaning* of the journal — theses, emotions, outcomes — lives in Walrus Memory;
 * this file only keeps what the UI needs to render quickly and the blob IDs that point there.
 */
interface DbShape {
  users: Record<string, User>;
  positions: Position[];
  journal: JournalEntry[];
  chats: Record<string, ChatMessage[]>;
  rules: TradingRule[];
}

const DB_FILE = path.join(config.dataDir, "db.json");
const CHAT_HISTORY_LIMIT = 20;

function load(): DbShape {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      users: parsed.users ?? {},
      // Positions created before limit orders existed were all market fills.
      positions: (parsed.positions ?? []).map((p) => ({ ...p, orderType: p.orderType ?? "market", placedAt: p.placedAt ?? p.openedAt })),
      journal: parsed.journal ?? [],
      chats: parsed.chats ?? {},
      rules: parsed.rules ?? [],
    };
  } catch {
    return { users: {}, positions: [], journal: [], chats: {}, rules: [] };
  }
}

const db: DbShape = load();
let saveTimer: NodeJS.Timeout | undefined;

function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}

export function flushStore(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export const newId = (): string => randomUUID();

// ---- users ----

export function upsertUser(user: Omit<User, "createdAt"> & Partial<Pick<User, "createdAt">>): User {
  const existing = db.users[user.id];
  const merged: User = {
    ...existing,
    ...Object.fromEntries(Object.entries(user).filter(([, v]) => v !== undefined)),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  } as User;
  db.users[user.id] = merged;
  persist();
  return merged;
}

export const getUser = (id: string): User | undefined => db.users[id];

/** Connects (or, with undefined, disconnects) the user's personal Walrus Memory account. */
export function setUserMemwal(id: string, memwal: User["memwal"]): void {
  const user = db.users[id];
  if (!user) return;
  if (memwal) user.memwal = memwal;
  else delete user.memwal;
  persist();
}
export const allUsers = (): User[] => Object.values(db.users);

// ---- positions ----

export function addPosition(position: Position): Position {
  db.positions.push(position);
  persist();
  return position;
}

export function updatePosition(id: string, patch: Partial<Position>): Position | undefined {
  const position = db.positions.find((p) => p.id === id);
  if (!position) return undefined;
  Object.assign(position, patch);
  persist();
  return position;
}

export const getPosition = (id: string): Position | undefined => db.positions.find((p) => p.id === id);

export const positionsFor = (userId: string): Position[] =>
  db.positions
    .filter((p) => p.userId === userId)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

export const openPositions = (): Position[] => db.positions.filter((p) => p.status === "open");
export const pendingOrders = (): Position[] => db.positions.filter((p) => p.status === "pending");

// ---- journal ----

export function addJournal(entry: JournalEntry): JournalEntry {
  db.journal.push(entry);
  persist();
  return entry;
}

export function updateJournal(id: string, patch: Partial<JournalEntry>): void {
  const entry = db.journal.find((j) => j.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  persist();
}

export const journalFor = (userId: string, positionId?: string): JournalEntry[] =>
  db.journal
    .filter((j) => j.userId === userId && (!positionId || j.positionId === positionId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ---- chat history (short-term context only; long-term lives in Walrus Memory) ----

export function pushChat(userId: string, message: ChatMessage): void {
  const history = (db.chats[userId] ??= []);
  history.push(message);
  if (history.length > CHAT_HISTORY_LIMIT) history.splice(0, history.length - CHAT_HISTORY_LIMIT);
  persist();
}

export const chatHistory = (userId: string): ChatMessage[] => db.chats[userId] ?? [];

export function clearChat(userId: string): void {
  db.chats[userId] = [];
  persist();
}

// ---- personal trading rules ----

export const rulesFor = (userId: string): TradingRule[] =>
  db.rules.filter((r) => r.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function addRule(rule: TradingRule): TradingRule {
  db.rules.push(rule);
  persist();
  return rule;
}

export function updateRule(id: string, patch: Partial<TradingRule>): void {
  const rule = db.rules.find((r) => r.id === id);
  if (!rule) return;
  Object.assign(rule, patch);
  persist();
}

export function removeRule(userId: string, id: string): TradingRule | undefined {
  const i = db.rules.findIndex((r) => r.id === id && r.userId === userId);
  if (i < 0) return undefined;
  const [removed] = db.rules.splice(i, 1);
  persist();
  return removed;
}

export function stats() {
  const perUser = allUsers().map((u) => {
    const entries = db.journal.filter((j) => j.userId === u.id);
    return {
      userId: u.id,
      username: u.username,
      memories: entries.length,
      storedOnWalrus: entries.filter((j) => j.memory.status === "stored").length,
      positions: db.positions.filter((p) => p.userId === u.id).length,
    };
  });
  return {
    users: perUser.length,
    totalMemories: db.journal.length,
    storedOnWalrus: db.journal.filter((j) => j.memory.status === "stored").length,
    perUser,
  };
}
