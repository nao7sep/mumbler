/** An authored renderer message presents the failure; its diagnostic stays in main. */
export const IPC_FAILURE = { kind: "ipc-failure" } as const;
export type IpcFailure = typeof IPC_FAILURE;
export type IpcResult<T> = T | IpcFailure;

export function isIpcFailure(value: unknown): value is IpcFailure {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "ipc-failure";
}
