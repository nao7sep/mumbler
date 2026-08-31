import type { ReactElement } from "react";
import type { MumblerCard } from "@shared/app-shell";

import { CloseIcon, ErrorIcon } from "./Icon";

export type AppNotification =
  | { id: string; message: string; kind: "toast" }
  | { id: string; message: string; kind: "persistent"; variant: "info" | "error" };

export type PipelineNotification =
  | { message: string; kind: "toast" }
  | { message: string; kind: "persistent"; variant: "error" };

export function pipelineNotification(card: MumblerCard): PipelineNotification | null {
  if (card.status === "Ready to Save") {
    return { message: `Ready to save: ${card.originalFilename}`, kind: "toast" };
  }
  if (card.status === "Error") {
    return {
      message: `Failed: ${card.originalFilename} — ${card.lastError?.message ?? "Unknown error"}`,
      kind: "persistent",
      variant: "error",
    };
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
  const persistent = notifications.filter(
    (notification): notification is Extract<AppNotification, { kind: "persistent" }> =>
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
          {notification.variant === "error" ? (
            <span className="persistent-notice__severity">
              <ErrorIcon />
              <span>Error</span>
            </span>
          ) : null}
          <span className="persistent-notice__message">{notification.message}</span>
          <button
            type="button"
            className="button button--ghost button--compact"
            onClick={() => onDismiss(notification.id)}
            aria-label="Dismiss notification"
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
          {notification.message}
        </div>
      ))}
    </div>
  );
}
