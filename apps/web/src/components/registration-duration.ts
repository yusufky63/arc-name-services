export type DurationNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function durationNavigationTarget(
  currentIndex: number,
  key: DurationNavigationKey,
  optionCount: number,
) {
  if (optionCount <= 0) return 0;
  const lastIndex = optionCount - 1;
  const boundedIndex = Math.min(Math.max(currentIndex, 0), lastIndex);
  if (key === "Home") return 0;
  if (key === "End") return lastIndex;
  if (key === "ArrowDown") return Math.min(boundedIndex + 1, lastIndex);
  return Math.max(boundedIndex - 1, 0);
}
