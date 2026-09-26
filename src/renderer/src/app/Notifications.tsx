import type { ReactElement } from "react";
import type { MumblerCard } from "@shared/app-shell";

import { message, type Message } from "@shared/i18n/translate";

import { CloseIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";

export type AppNotification =
  | { id: string; message: Message; kind: "toast" }
  | {
      id: string;
      owner: string;
      message: Message;
      kind: "persistent";
      variant: "info" | "error";
    };

export type PersistentNotification = Extract<AppNotification, { kind: "persistent" }>;

export function upsertPersistentNotification(
  notifications: AppNotification[],
  next: PersistentNotification,
): AppNotification[] {
  return [...clearPersistentOwner(notifications, next.owner), next];
}

export function clearPersistentOwner(
  notifications: AppNotification[],
  owner: string,
): AppNotification[] {
  return notifications.filter(
    (notification) => notification.kind !== "persistent" || notification.owner !== owner,
  );
}

export type PipelineCompletionNotification =
  { message: Message; kind: "toast" };

// Only a finished generation announces itself; a save handing its card back as
// Ready to Save (a conflict, a cancel, a failure) is reported by the save itself.
export function pipelineCompletionNotification(
  previous: MumblerCard,
  card: MumblerCard,
): PipelineCompletionNotification | null {
  if (card.status === "Ready to Save" && previous.status !== "Saving") {
    return { message: message("notice.readyToSave", { file: card.originalFilename }), kind: "toast" };
  }
  return null;
}

interface NotificationProps {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}

export function PersistentNotifications({
  notifications,
  onDismiss,
}: NotificationProps): ReactElement | null {
  const i18n = useI18n();
  const persistent = notifications.filter(
    (notification): notification is PersistentNotification =>
      notification.kind === "persistent",
  );
  if (persistent.length === 0) return null;

  return (
    <div className="persistent-strip">
      {persistent.map((notification) => (
        <div
          key={notification.id}
          role={notification.variant === "error" ? "alert" : "status"}
          aria-atomic="true"
          className={`persistent-notice persistent-notice--${notification.variant}`}
        >
          <span className="persistent-notice__message">{i18n.text(notification.message)}</span>
          <button
            type="button"
            className="result-close"
            onClick={() => onDismiss(notification.id)}
            aria-label={i18n.t("notice.close")}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ToastNotifications({
  notifications,
  onDismiss,
}: NotificationProps): ReactElement | null {
  const i18n = useI18n();
  const toasts = notifications.filter(
    (notification): notification is Extract<AppNotification, { kind: "toast" }> =>
      notification.kind === "toast",
  );
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((notification) => (
        <div
          key={notification.id}
          role="status"
          aria-atomic="true"
          className="toast toast--info"
          onClick={() => onDismiss(notification.id)}
        >
          {i18n.text(notification.message)}
        </div>
      ))}
    </div>
  );
}
