// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../../../src/renderer/src/app/RendererErrorBoundary";

const HOSTILE = "EACCES /Users/nao/.mumbler/quarantine/internal-state.json";

function Broken(): React.JSX.Element { throw new Error(HOSTILE); }

describe("RendererErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps a render diagnostic out of the authored recovery surface", () => {
    const reportRendererError = vi.fn().mockResolvedValue({});
    Object.defineProperty(window, "mumbler", { configurable: true, value: { reportRendererError } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<RendererErrorBoundary><Broken /></RendererErrorBoundary>);

    expect(screen.getByRole("alert").textContent).toContain("Mumbler could not keep this window open.");
    expect(screen.getByRole("alert").textContent).not.toContain(HOSTILE);
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({ message: HOSTILE }));
  });
});
