import { useEffect, useRef, useState, type ReactElement } from "react";
import type { MumblerCard } from "@shared/app-shell";

import { message, nameValue, type Message } from "@shared/i18n/translate";

import { CloseIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";

export type AppNotification =
  | { id: string; message: Message; kind: "toast" }
  | {
      id: string;
      owner: string;
      message: Message;
      kind: "persistent";
      variant: "info" | "warning" | "error";
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
  previous: Pick<MumblerCard, "status">,
  card: Pick<MumblerCard, "status" | "originalFilename">,
): PipelineCompletionNotification | null {
  if (card.status === "Ready to Save" && previous.status !== "Saving") {
    return { message: message("notice.readyToSave", { file: nameValue(card.originalFilename) }), kind: "toast" };
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
          <span className="persistent-notice__message">{i18n.node(notification.message)}</span>
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

// Long enough to read: a base, then more for each character, up to a ceiling.
const TOAST_BASE_MS = 4000;
const TOAST_PER_CHARACTER_MS = 60;
const TOAST_MAX_MS = 15000;

export function toastDuration(text: string): number {
  return Math.min(TOAST_MAX_MS, TOAST_BASE_MS + [...text].length * TOAST_PER_CHARACTER_MS);
}

function Toast({
  notification,
  onDismiss,
}: {
  notification: Extract<AppNotification, { kind: "toast" }>;
  onDismiss: (id: string) => void;
}): ReactElement {
  const i18n = useI18n();
  const [paused, setPaused] = useState(false);
  // What is left of the countdown, so a pause resumes rather than restarts it.
  const remainingMs = useRef(toastDuration(i18n.text(notification.message)));

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(notification.id), remainingMs.current);
    return () => {
      clearTimeout(timer);
      remainingMs.current -= Date.now() - startedAt;
    };
  }, [paused, notification.id, onDismiss]);

  return (
    <div
      role="status"
      aria-atomic="true"
      className="toast toast--info"
      onClick={() => onDismiss(notification.id)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {i18n.node(notification.message)}
    </div>
  );
}

// Each toast leaves on its own once read; hovering or focusing one holds it,
// and a click dismisses it at once.
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
        <Toast key={notification.id} notification={notification} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
