export function getToolResultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const error = (result as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  return undefined;
}
