export type AgentArtifactPayload = {
  artifactType?: unknown;
  label?: unknown;
  downloadUrl?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  tab?: unknown;
  files?: unknown;
};

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getArtifactValidationError(
  artifact: AgentArtifactPayload | null | undefined,
): string | null {
  if (!artifact || typeof artifact !== "object") {
    return "artifact payload is missing";
  }

  if (!hasString(artifact.artifactType)) {
    return "artifactType is missing";
  }

  switch (artifact.artifactType) {
    case "download":
      return hasString(artifact.downloadUrl)
        ? null
        : "download artifact is missing downloadUrl";
    case "image":
      return hasString(artifact.imageUrl)
        ? null
        : "image artifact is missing imageUrl";
    case "audio":
      return hasString(artifact.audioUrl)
        ? null
        : "audio artifact is missing audioUrl";
    case "tab_link":
      return hasString(artifact.tab) ? null : "tab_link artifact is missing tab";
    case "workspace_listing":
      return Array.isArray(artifact.files)
        ? null
        : "workspace_listing artifact is missing files";
    case "workspace_file":
      return hasString(artifact.label)
        ? null
        : "workspace_file artifact is missing label";
    case "text":
      return null;
    default:
      return null;
  }
}

function stripInternalErrorNoise(message: string): string {
  return message
    .split(/\.?\s*Please refer to https?:\/\//)
    .shift()!
    .replace(/\[JUDGE\][^\]]*\]/gi, "")
    .replace(/thought_signature/gi, "")
    .trim();
}

function parseAgentErrorPayload(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.error?.message ?? parsed?.message;
    return typeof inner === "string" && inner.trim()
      ? stripInternalErrorNoise(inner)
      : null;
  } catch {
    return null;
  }
}

export function getCleanAgentErrorMessage(error: unknown): string {
  const raw =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");

  const directPayload = parseAgentErrorPayload(raw);
  if (directPayload) return directPayload;

  const jsonStart = raw.indexOf("{");
  if (jsonStart !== -1) {
    const embeddedPayload = parseAgentErrorPayload(raw.slice(jsonStart));
    if (embeddedPayload) return embeddedPayload;
  }

  return stripInternalErrorNoise(raw) || "Unknown copilot error";
}
