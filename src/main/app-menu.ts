import { Menu, type MenuItemConstructorOptions } from "electron";

import type { Translator } from "@shared/i18n/translate";

// The native application menu: Electron's default menu, built explicitly so
// every title and item speaks the interface language (Electron labels its role
// items in English). The roles keep their standard actions and accelerators.
// On macOS the Edit menu is titled in the interface language; AppKit adds its
// own items to it (Emoji & Symbols, Start Dictation, AutoFill, Writing Tools)
// whatever it is titled (app-chrome-conventions, localization-conventions).
// Those AppKit items speak the language AppKit settled on when the application
// object was created, which Electron does before this code runs: they follow
// the computer's language (the bundle declares the set in CFBundleLocalizations),
// and a different language chosen in Settings does not reach them.
export function buildApplicationMenuTemplate(
  t: Translator["t"],
  platform: NodeJS.Platform,
  appName: string,
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const app = { app: appName };
  const separator: MenuItemConstructorOptions = { type: "separator" };

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: "about", label: t("nativeMenu.about", app) },
      separator,
      { role: "services", label: t("nativeMenu.services") },
      separator,
      { role: "hide", label: t("nativeMenu.hide", app) },
      { role: "hideOthers", label: t("nativeMenu.hideOthers") },
      { role: "unhide", label: t("nativeMenu.showAll") },
      separator,
      { role: "quit", label: t("nativeMenu.quit", app) },
    ],
  };

  const editItems: MenuItemConstructorOptions[] = [
    { role: "undo", label: t("nativeMenu.undo") },
    { role: "redo", label: t("nativeMenu.redo") },
    separator,
    { role: "cut", label: t("nativeMenu.cut") },
    { role: "copy", label: t("nativeMenu.copy") },
    { role: "paste", label: t("nativeMenu.paste") },
    ...(isMac
      ? [
          { role: "pasteAndMatchStyle", label: t("nativeMenu.pasteAndMatchStyle") },
          { role: "delete", label: t("nativeMenu.delete") },
          { role: "selectAll", label: t("nativeMenu.selectAll") },
          separator,
          {
            label: t("nativeMenu.speech"),
            submenu: [
              { role: "startSpeaking", label: t("nativeMenu.startSpeaking") },
              { role: "stopSpeaking", label: t("nativeMenu.stopSpeaking") },
            ],
          },
        ] satisfies MenuItemConstructorOptions[]
      : [
          { role: "delete", label: t("nativeMenu.delete") },
          separator,
          { role: "selectAll", label: t("nativeMenu.selectAll") },
        ] satisfies MenuItemConstructorOptions[]),
  ];

  return [
    ...(isMac ? [appMenu] : []),
    {
      label: t("nativeMenu.file"),
      submenu: [
        isMac
          ? { role: "close", label: t("nativeMenu.closeWindow") }
          : { role: "quit", label: t("nativeMenu.exit") },
      ],
    },
    { label: t("nativeMenu.edit"), submenu: editItems },
    {
      label: t("nativeMenu.view"),
      submenu: [
        { role: "reload", label: t("nativeMenu.reload") },
        { role: "forceReload", label: t("nativeMenu.forceReload") },
        { role: "toggleDevTools", label: t("nativeMenu.toggleDevTools") },
        separator,
        { role: "resetZoom", label: t("nativeMenu.actualSize") },
        { role: "zoomIn", label: t("nativeMenu.zoomIn") },
        { role: "zoomOut", label: t("nativeMenu.zoomOut") },
        separator,
        { role: "togglefullscreen", label: t("nativeMenu.toggleFullScreen") },
      ],
    },
    {
      // The window role registers this as the app's windows menu on macOS, so
      // macOS lists the open windows in it.
      role: "window",
      label: t("nativeMenu.window"),
      submenu: isMac
        ? [
            { role: "minimize", label: t("nativeMenu.minimize") },
            { role: "zoom", label: t("nativeMenu.zoom") },
            separator,
            { role: "front", label: t("nativeMenu.bringAllToFront") },
          ]
        : [
            { role: "minimize", label: t("nativeMenu.minimize") },
            { role: "close", label: t("nativeMenu.close") },
          ],
    },
    { role: "help", label: t("nativeMenu.help"), submenu: [] },
  ];
}

/** Installs the menu in the current interface language; called again when it changes. */
export function installApplicationMenu(translator: Translator, appName: string): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildApplicationMenuTemplate(translator.t, process.platform, appName)),
  );
}

// The context menu over editable text and selections. Electron labels its role
// items in English, so each carries the interface language's label.
export function buildContextMenuTemplate(
  t: Translator["t"],
  params: {
    isEditable: boolean;
    misspelledWord: string;
    dictionarySuggestions: string[];
    editFlags: {
      canUndo: boolean;
      canRedo: boolean;
      canCut: boolean;
      canCopy: boolean;
      canPaste: boolean;
      canSelectAll: boolean;
    };
  },
  replaceMisspelling: (word: string) => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length > 0) {
      for (const word of params.dictionarySuggestions) {
        template.push({ label: word, click: () => replaceMisspelling(word) });
      }
    } else {
      template.push({ label: t("contextMenu.noSuggestions"), enabled: false });
    }
    template.push({ type: "separator" });
  }

  if (params.isEditable) {
    template.push(
      { role: "undo", label: t("nativeMenu.undo"), enabled: params.editFlags.canUndo },
      { role: "redo", label: t("nativeMenu.redo"), enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", label: t("nativeMenu.cut"), enabled: params.editFlags.canCut },
    );
  }

  template.push({ role: "copy", label: t("nativeMenu.copy"), enabled: params.editFlags.canCopy });

  if (params.isEditable) {
    template.push(
      { role: "paste", label: t("nativeMenu.paste"), enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: t("nativeMenu.selectAll"), enabled: params.editFlags.canSelectAll },
    );
  }

  return template;
}
