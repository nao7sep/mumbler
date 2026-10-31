// The identity header a Mumbler file of `kind` opens with (file-identity-conventions).
export function header(kind: string, version = 1): { format: { owner: string; kind: string; version: number }; writer: { name: string; version: string } } {
  return { format: { owner: "mumbler", kind, version }, writer: { name: "mumbler", version: __APP_VERSION__ } };
}
