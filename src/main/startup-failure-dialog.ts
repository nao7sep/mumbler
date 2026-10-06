import type { Translator } from "@shared/i18n/translate";

import { renderPlainDialogHtml, showPlainDialog, type PlainDialog } from "./plain-dialog";

export type StartupFailureChoice = "restart" | "close";

function startupFailureDialog(translator: Translator): PlainDialog<StartupFailureChoice> {
  return {
    language: translator.language,
    title: translator.t("startup.title"),
    bodyLabel: translator.t("startup.detailsLabel"),
    body: translator.t("startup.body"),
    detail: translator.t("startup.detail"),
    actions: [
      { choice: "close", label: translator.t("startup.close") },
      { choice: "restart", label: translator.t("startup.restart"), tone: "primary" },
    ],
    focus: "restart",
    dismiss: "close",
  };
}

/** Plain fatal-startup surface with no framework/application severity icon. */
export function showStartupFailureDialog(translator: Translator): Promise<StartupFailureChoice> {
  return showPlainDialog(startupFailureDialog(translator)).choice;
}

export function renderStartupFailureHtml(translator: Translator): string {
  return renderPlainDialogHtml(startupFailureDialog(translator));
}
