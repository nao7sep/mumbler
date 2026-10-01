import { openAsBlob } from "node:fs";
import { GenerateContentResponse } from "@google/genai";
import { GEMINI_ENDPOINT } from "@shared/ai-models";

export class GeminiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null, readonly providerMessage: string | null = null) {
    super(message);
    this.name = "GeminiHttpError";
  }
}

// Raw HTTP preserves Retry-After, which the SDK's ApiError discards. Every caller
// supplies its operation's abort signal; there is no transport retry loop.
export class GeminiClient {
  constructor(private readonly options: { apiKey: string; endpoint?: string }) {}

  private url(path: string): string {
    return `${(this.options.endpoint ?? GEMINI_ENDPOINT).replace(/\/$/, "")}/${path}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: { "x-goog-api-key": this.options.apiKey, ...init.headers },
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text || response.statusText;
      let providerMessage: string | null = null;
      try { const supplied = JSON.parse(text).error?.message; if (typeof supplied === "string") { message = supplied; providerMessage = supplied; } } catch { /* Plain-text provider errors are valid. */ }
      throw new GeminiHttpError(message, response.status, response.headers.get("retry-after"), providerMessage);
    }
    return response;
  }

  async generateContent(params: {
    model: string;
    contents: unknown;
    config: { abortSignal: AbortSignal; thinkingConfig?: unknown; maxOutputTokens?: number };
  }): Promise<GenerateContentResponse> {
    const { abortSignal, ...generationConfig } = params.config;
    const response = await this.request(this.url(`v1beta/models/${encodeURIComponent(params.model)}:generateContent`), {
      method: "POST", signal: abortSignal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: params.contents, generationConfig }),
    });
    return Object.assign(new GenerateContentResponse(), await response.json());
  }

  async upload(params: { file: string; config: { mimeType: string; abortSignal: AbortSignal } }): Promise<{ name?: string; uri?: string; mimeType?: string }> {
    const blob = await openAsBlob(params.file, { type: params.config.mimeType });
    const start = await this.request(this.url("upload/v1beta/files"), {
      method: "POST", signal: params.config.abortSignal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(blob.size),
        "X-Goog-Upload-Header-Content-Type": params.config.mimeType,
      },
      body: JSON.stringify({ file: { mimeType: params.config.mimeType } }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    await start.body?.cancel();
    if (!uploadUrl) throw new Error("Gemini returned no upload URL.");
    const response = await this.request(uploadUrl, {
      method: "POST", signal: params.config.abortSignal,
      headers: { "Content-Type": params.config.mimeType, "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
      body: blob,
    });
    const { file } = await response.json() as { file?: { name?: string; uri?: string; mimeType?: string } };
    if (!file?.name || !file.uri) throw new Error("Gemini returned an incomplete uploaded file.");
    return file;
  }

  async delete(params: { name: string; config: { abortSignal: AbortSignal } }): Promise<void> {
    const response = await this.request(this.url(`v1beta/${params.name}`), { method: "DELETE", signal: params.config.abortSignal });
    await response.body?.cancel();
  }

  async list(signal: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = "";
    do {
      const url = new URL(this.url("v1beta/models"));
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.request(url.href, { signal });
      const page = await response.json() as { models?: { name?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
      for (const model of page.models ?? []) {
        if (model.name && model.supportedGenerationMethods?.includes("generateContent")) ids.push(model.name.replace(/^models\//, ""));
      }
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return ids;
  }
}
