import { config } from "./config.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const llmEnabled = Boolean(config.llm.apiKey);

/**
 * Minimal OpenAI-compatible chat completion call. Works with Groq, OpenRouter,
 * Together, Fireworks, a local Ollama (`http://localhost:11434/v1`) — any open model.
 */
export async function complete(messages: LlmMessage[], opts: { temperature?: number; maxTokens?: number } = {}) {
  if (!llmEnabled) throw new Error("LLM_API_KEY is not set");
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 700,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  // Reasoning models (Qwen3, DeepSeek-R1) may inline their chain of thought.
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Detects the language of a message from its script; null for Latin text (the model handles that on its own). */
export function detectLanguage(message: string): string | null {
  if (/[іїєґІЇЄҐ]/.test(message)) return "Ukrainian";
  if (/[ыэъёЫЭЪЁ]/.test(message)) return "Russian";
  if (/[а-яА-Я]/.test(message)) return "the Cyrillic language the user wrote in";
  return null;
}

/** Names the reply language explicitly — open models follow "reply in Ukrainian" far better than "same language". */
export function languageInstruction(message: string): string {
  const lang = detectLanguage(message);
  return lang
    ? `The user's message is in ${lang}. Write your entire reply in ${lang}, even though memories and earlier messages may be in English.`
    : "Write your reply in the same language as the user message that follows, even if earlier messages or memories are in another language.";
}
