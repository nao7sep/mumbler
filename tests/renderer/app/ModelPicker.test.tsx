// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "@renderer/app/ModelPicker";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("ModelPicker", () => {
  it("keeps an unknown typed id and groups all three sources without replacing the selection", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const onChange = vi.fn();
    await act(async () => root?.render(React.createElement(ModelPicker, {
      label: "Outline Model", kind: "text-balanced", value: "unknown-model", fetched: ["gemini-future"], extra: ["custom-extra"], onChange,
    })));
    const input = document.querySelector<HTMLInputElement>("input")!;
    const select = document.querySelector<HTMLSelectElement>("select")!;
    expect(input.value).toBe("unknown-model");
    expect(select.value).toBe("unknown-model");
    expect(Array.from(select.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["App suggestions", "Provider models", "Your extra ids", "Out of list"]);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["gemini-3.8-flash", "gemini-future", "custom-extra", "unknown-model"]);
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Outline Model");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "brand-new-model");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("brand-new-model");
  });
});
