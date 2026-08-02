export const FULL_CAPTION_USER_MESSAGE_WINDOW = 7;

type HistoryPart = {
  kind?: string;
  name?: string;
  done?: boolean;
  result?: unknown;
};

type HistoryMessage = {
  role?: string;
  parts?: HistoryPart[];
};

function isCompletedCaptionPart(part: HistoryPart): boolean {
  return part.kind === "tool_start" && part.name === "get_youtube_captions" && part.done === true;
}

function compactCaptionResult(result: unknown, reason: "superseded" | "expired"): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { content: _content, ...metadata } = result as Record<string, unknown>;
  return {
    ...metadata,
    fullContentInContext: false,
    contentOmittedReason: reason,
    message:
      reason === "superseded"
        ? "Full caption content omitted because a newer caption fetch replaced it."
        : `Full caption content omitted after ${FULL_CAPTION_USER_MESSAGE_WINDOW} subsequent user messages. Fetch captions again if the full transcript is needed.`,
  };
}

export function captionResultForHistory(
  messages: HistoryMessage[],
  messageIndex: number,
  part: HistoryPart,
): unknown {
  if (!isCompletedCaptionPart(part)) return part.result;

  let latestCaptionMessageIndex = -1;
  let latestCaptionPart: HistoryPart | undefined;
  for (let index = messages.length - 1; index >= 0 && !latestCaptionPart; index--) {
    latestCaptionPart = messages[index]?.parts?.findLast(isCompletedCaptionPart);
    if (latestCaptionPart) latestCaptionMessageIndex = index;
  }

  if (latestCaptionMessageIndex !== messageIndex || latestCaptionPart !== part) {
    return compactCaptionResult(part.result, "superseded");
  }

  const subsequentUserMessages = messages
    .slice(messageIndex + 1)
    .filter((message) => message.role === "user").length;
  if (subsequentUserMessages > FULL_CAPTION_USER_MESSAGE_WINDOW) {
    return compactCaptionResult(part.result, "expired");
  }

  return part.result;
}
