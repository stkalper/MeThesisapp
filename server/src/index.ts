import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApi } from "./api.js";
import { createBot, startBot } from "./bot.js";
import { config } from "./config.js";
import { llmEnabled } from "./llm.js";
import { memory } from "./memory.js";
import { startMonitor } from "./monitor.js";
import { flushStore } from "./store.js";

const app = express();
app.disable("x-powered-by");
app.use("/api", createApi());

if (fs.existsSync(config.webDistDir)) {
  app.use(express.static(config.webDistDir, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.webDistDir, "index.html")));
} else {
  app.get("/", (_req, res) => res.send("Thesis Keeper API is running. Build the webapp (npm run build) to serve the Mini App."));
}

app.listen(config.port, config.host, async () => {
  console.log(`[server] http://${config.host}:${config.port}`);
  const health = await memory.health();
  console.log(`[memory] mode=${memory.mode} → ${health.detail}`);
  console.log(`[llm] ${llmEnabled ? `${config.llm.model} via ${config.llm.baseUrl}` : "disabled (set LLM_API_KEY)"}`);

  const bot = createBot();
  if (bot) {
    await startBot(bot).catch((err) => console.error("[bot] failed to start:", err.message));
    startMonitor(bot);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    flushStore();
    process.exit(0);
  });
}
