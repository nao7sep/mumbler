import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({ Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() } }));

import { buildApplicationMenuTemplate, buildContextMenuTemplate } from "@main/app-menu";
import { CATALOGUES } from "@shared/i18n/catalogues";
import { LANGUAGES } from "@shared/i18n/languages";
import { createTranslator } from "@shared/i18n/translate";

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.label === undefined ? [] : [item.label]),
    ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
  ]);
}

const KEYS = new Set(Object.keys(CATALOGUES.en));

describe("application menu", () => {
  it("titles the Edit menu and every item in the interface language on macOS", () => {
    const template = buildApplicationMenuTemplate(createTranslator("ja").t, "darwin", "Mumbler");
    expect(template.map((item) => item.label)).toEqual(["Mumbler", "ファイル", "編集", "表示", "ウインドウ", "ヘルプ"]);
    const edit = template[2]!.submenu as MenuItemConstructorOptions[];
    expect(edit.filter((item) => item.role).map((item) => item.role)).toEqual([
      "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll",
    ]);
    expect(labels(template)).toContain("Mumblerを終了");
  });

  it("registers the Window menu by role and keeps the roles' own actions", () => {
    const template = buildApplicationMenuTemplate(createTranslator("de").t, "darwin", "Mumbler");
    const window = template.find((item) => item.role === "window")!;
    expect(window.label).toBe("Fenster");
    expect((window.submenu as MenuItemConstructorOptions[]).map((item) => item.role)).toEqual(["minimize", "zoom", undefined, "front"]);
  });

  it("leaves out the app menu on Windows and offers Exit instead of Close Window", () => {
    const template = buildApplicationMenuTemplate(createTranslator("en").t, "win32", "Mumbler");
    expect(template.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect((template[0]!.submenu as MenuItemConstructorOptions[])[0]).toMatchObject({ role: "quit", label: "Exit" });
  });

  it.each(LANGUAGES)("labels every item in %s without showing a key", (language) => {
    for (const platform of ["darwin", "win32"] as const) {
      const shown = labels(buildApplicationMenuTemplate(createTranslator(language).t, platform, "Mumbler"));
      expect(shown.filter((label) => KEYS.has(label) || label.length === 0)).toEqual([]);
    }
  });
});

describe("context menu", () => {
  const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

  it("labels the edit roles and the empty-suggestions row in the interface language", () => {
    const template = buildContextMenuTemplate(
      createTranslator("fr").t,
      { isEditable: true, misspelledWord: "mumbel", dictionarySuggestions: [], editFlags: flags },
      vi.fn(),
    );
    expect(template[0]).toMatchObject({ label: "Aucune suggestion", enabled: false });
    expect(template.filter((item) => item.role).map((item) => [item.role, item.label])).toEqual([
      ["undo", "Annuler"],
      ["redo", "Rétablir"],
      ["cut", "Couper"],
      ["copy", "Copier"],
      ["paste", "Coller"],
      ["selectAll", "Tout sélectionner"],
    ]);
  });

  it("offers only Copy over a read-only selection, and spelling suggestions verbatim", () => {
    const replace = vi.fn();
    const template = buildContextMenuTemplate(
      createTranslator("en").t,
      { isEditable: false, misspelledWord: "teh", dictionarySuggestions: ["the"], editFlags: flags },
      replace,
    );
    expect(template.map((item) => item.label ?? item.type)).toEqual(["the", "separator", "Copy"]);
    (template[0]!.click as () => void)();
    expect(replace).toHaveBeenCalledWith("the");
  });
});
