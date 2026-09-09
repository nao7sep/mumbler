/** Native workspace coordinates; never pass these to Electron's DIP setters. */
export interface WindowsNormalBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function normalizeWindowsNormalBounds(value: unknown): WindowsNormalBounds | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { left, top, right, bottom } = value as Record<string, unknown>;
  const coordinate = (item: unknown): item is number =>
    typeof item === "number" && Number.isInteger(item) && item >= -2147483648 && item <= 2147483647;
  if (!coordinate(left) || !coordinate(top) || !coordinate(right) || !coordinate(bottom)
    || right <= left || bottom <= top || right - left > 2147483647 || bottom - top > 2147483647) return null;
  return { left, top, right, bottom };
}
