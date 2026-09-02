import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";

import {
  GeminiTimeoutError,
  isRetryableGeminiError,
} from "@main/core/gemini-adapter";
import { CancelledError, isCancelledError } from "@main/core/cancellation";

describe("isRetryableGeminiError", () => {
  it("does not retry timeouts or cancellations", () => {
    expect(isRetryableGeminiError(new GeminiTimeoutError(30000))).toBe(false);
    expect(isRetryableGeminiError(new CancelledError())).toBe(false);
  });

  it("retries HTTP 429 and 5xx ApiErrors", () => {
    expect(isRetryableGeminiError(new ApiError({ message: "rate limited", status: 429 }))).toBe(
      true,
    );
    expect(isRetryableGeminiError(new ApiError({ message: "server", status: 500 }))).toBe(true);
    expect(isRetryableGeminiError(new ApiError({ message: "gateway", status: 503 }))).toBe(true);
  });

  it("does not retry client ApiErrors below 500 (other than 429)", () => {
    expect(isRetryableGeminiError(new ApiError({ message: "bad request", status: 400 }))).toBe(
      false,
    );
    expect(isRetryableGeminiError(new ApiError({ message: "forbidden", status: 403 }))).toBe(false);
  });

  it("does not infer retry policy from arbitrary exception prose", () => {
    expect(isRetryableGeminiError(new Error("network timeout while connecting"))).toBe(false);
    expect(isRetryableGeminiError(new Error("fetch failed"))).toBe(false);
    expect(isRetryableGeminiError(new Error("stream interrupted"))).toBe(false);
  });

  it("does not retry generic errors or non-error values", () => {
    expect(isRetryableGeminiError(new Error("invalid argument"))).toBe(false);
    expect(isRetryableGeminiError("boom")).toBe(false);
    expect(isRetryableGeminiError(null)).toBe(false);
  });
});

describe("isCancelledError", () => {
  it("matches only the cancellation error", () => {
    expect(isCancelledError(new CancelledError())).toBe(true);
    expect(isCancelledError(new GeminiTimeoutError(1000))).toBe(false);
    expect(isCancelledError(new Error("x"))).toBe(false);
  });
});
