import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..", "..");

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  port: Number(env("PORT", "3000")),
  /** Interface to bind; set 127.0.0.1 behind a reverse proxy so the port is not exposed directly. */
  host: env("HOST", "0.0.0.0"),
  /** Public HTTPS URL where the Mini App is served, e.g. https://thesis-keeper.onrender.com */
  publicUrl: env("PUBLIC_URL").replace(/\/$/, ""),
  dataDir: path.resolve(ROOT_DIR, env("DATA_DIR", "data")),
  webDistDir: path.resolve(ROOT_DIR, "webapp", "dist"),
  isDev: env("NODE_ENV") !== "production",
  /** Lets the Mini App work in a normal browser during local development. */
  devUserId: env("DEV_USER_ID"),

  telegram: {
    botToken: env("TELEGRAM_BOT_TOKEN"),
  },

  memwal: {
    key: env("MEMWAL_PRIVATE_KEY"),
    accountId: env("MEMWAL_ACCOUNT_ID"),
    serverUrl: env("MEMWAL_SERVER_URL", "https://relayer.memory.walrus.xyz"),
    /** Prefix for per-user namespaces: `${prefix}:tg:${telegramId}` */
    namespacePrefix: env("MEMWAL_NAMESPACE_PREFIX", "thesis-keeper"),
  },

  llm: {
    /** Any OpenAI-compatible endpoint: Groq, OpenRouter, Together, Ollama, ... */
    baseUrl: env("LLM_BASE_URL", "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL", "qwen/qwen3.8-27b"),
  },

  /** How often open positions are checked against target / invalidation levels. */
  monitorIntervalMs: Number(env("MONITOR_INTERVAL_MS", String(60_000))),
};

export const memwalEnabled = Boolean(config.memwal.key && config.memwal.accountId);

/** Walruscan explorer network for proof links. */
export const walrusNetwork = config.memwal.serverUrl.includes("staging") ? "testnet" : "mainnet";

export function walruscanBlobUrl(blobId: string): string {
  return `https://walruscan.com/${walrusNetwork}/blob/${blobId}`;
}
