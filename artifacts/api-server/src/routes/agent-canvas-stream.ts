const CANVAS_OPEN_TOKEN = "<canvas";

/**
 * Finds a suffix that may still become a complete hidden <canvas ...> opening
 * tag. The caller must retain that suffix instead of exposing it as chat text.
 *
 * This covers both kinds of model-stream boundaries:
 * - a split token, such as "<can" + "vas ...>"; and
 * - a complete token whose attributes/closing bracket arrive later, such as
 *   "<canvas" + " title=..." + ">".
 */
export function findIncompleteCanvasOpeningTagStart(buffer: string): number {
  const lower = buffer.toLowerCase();
  const fullTokenIndex = lower.lastIndexOf(CANVAS_OPEN_TOKEN);

  if (fullTokenIndex !== -1) {
    const suffix = buffer.slice(fullTokenIndex);
    const charAfterToken = suffix.charAt(CANVAS_OPEN_TOKEN.length);
    const hasValidBoundary =
      charAfterToken === "" || /[\s/>]/.test(charAfterToken);

    if (hasValidBoundary && !suffix.includes(">")) {
      return fullTokenIndex;
    }
  }

  const maxPartialLength = Math.min(
    CANVAS_OPEN_TOKEN.length - 1,
    lower.length,
  );
  for (let length = maxPartialLength; length > 0; length--) {
    if (CANVAS_OPEN_TOKEN.startsWith(lower.slice(-length))) {
      return buffer.length - length;
    }
  }

  return -1;
}
