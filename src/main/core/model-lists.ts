import { GoogleGenAI } from "@google/genai";
import { SUPPORTED_MODELS } from "@shared/ai-models";
import { readJsonFile, writeJsonFile } from "./file-io";
import type { AppLogger } from "./logger";

interface ModelListFact { fetchedAtUtc: string; ids: string[] }

// Best-effort provider facts, deliberately outside settings and backup history.
// Only the Settings open/Refresh IPC calls this owner; pipeline and startup do not.
export class ModelLists {
  private pending: { endpoint: string; promise: Promise<string[]> } | null = null;
  private lastEndpoint: string | null = null;
  private lastAttempt: { endpoint: string; atUtc: number } | null = null;
  private warned = false;
  private readonly controller = new AbortController();

  constructor(private readonly path: string, private readonly logger: AppLogger) {}

  async get(endpoint: string, force: boolean, key: () => Promise<string | null>): Promise<string[]> {
    if (this.controller.signal.aborted) return [];
    if (this.pending) {
      if (this.pending.endpoint === endpoint) return this.pending.promise;
      await this.pending.promise;
      return this.get(endpoint, true, key);
    }
    const promise = this.refresh(endpoint, force, key);
    this.pending = { endpoint, promise };
    try { return await promise; } finally { this.pending = null; }
  }

  private async refresh(endpoint: string, force: boolean, key: () => Promise<string | null>): Promise<string[]> {
    let cached: ModelListFact | null = null;
    try {
      const raw = await readJsonFile<{ gemini?: ModelListFact }>(this.path);
      const fact = raw?.gemini;
      if (fact && typeof fact.fetchedAtUtc === "string" && Number.isFinite(Date.parse(fact.fetchedAtUtc)) && Array.isArray(fact.ids) && fact.ids.every((id) => typeof id === "string")) cached = fact;
      else if (raw !== null) throw new Error("Invalid model-list cache.");
    } catch (error) { await this.warn(error); }
    if (!force && (this.lastEndpoint === null || this.lastEndpoint === endpoint) && cached && Date.now() - Date.parse(cached.fetchedAtUtc) < 86_400_000) return cached.ids;
    if (!force && this.lastAttempt?.endpoint === endpoint && Date.now() - this.lastAttempt.atUtc < 86_400_000) return cached?.ids ?? [];
    try {
      const apiKey = await key();
      if (!apiKey) return cached?.ids ?? [];
      this.lastAttempt = { endpoint, atUtc: Date.now() };
      const ai = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: endpoint, retryOptions: { attempts: 1 } } });
      const models = await ai.models.list({ config: { pageSize: 1000, abortSignal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]) } });
      const listed: string[] = [];
      for await (const model of models) {
        if (model.name && model.supportedActions?.includes("generateContent")) listed.push(model.name.replace(/^models\//, ""));
      }
      const ids = [...new Set(listed.filter((id) => SUPPORTED_MODELS.some((row) => row.id === id)))];
      const fact = { fetchedAtUtc: new Date().toISOString(), ids };
      // Not recorded: provider catalogue facts can be fetched again.
      if (this.controller.signal.aborted) return cached?.ids ?? [];
      try { await writeJsonFile(this.path, { gemini: fact }, { record: false }); } catch (error) { await this.warn(error); }
      this.lastEndpoint = endpoint;
      return ids;
    } catch (error) {
      if (!this.controller.signal.aborted) await this.warn(error);
      return cached?.ids ?? [];
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.pending?.promise;
  }

  private async warn(error: unknown): Promise<void> {
    if (this.warned) return;
    this.warned = true;
    await this.logger.warn("models.list", "Could not refresh provider model suggestions.", { error: error instanceof Error ? error.message : String(error) });
  }
}
