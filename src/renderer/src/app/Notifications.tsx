import type { ReactElement } from "react";
import type { MumblerCard } from "@shared/app-shell";

import { CloseIcon } from "./Icon";

export type AppNotification =
  | { id: string; message: string; kind: "toast" }
  | { id: string; message: string; kind: "persistent"; variant: "info" | "error" };

export type PipelineCompletionNotification =
  { message: string; kind: "toast" };

export function pipelineCompletionNotification(card: MumblerCard): PipelineCompletionNotification | null {
  if (card.status === "Ready to Save") {
    return { message: `Ready to save: ${card.originalFilename}`, kind: "toast" };
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
          <span className="persistent-notice__message">{notification.message}</span>
          <button
            type="button"
            className="result-close"
            onClick={() => onDismiss(notification.id)}
            aria-label="Close notification"
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
