export type StoredEmailSubmission = {
  email: string;
  name?: string;
  submittedAt: number;
};

const SUBMITTED_KEY = "videomaking.email-submission.v1";
const PROMPT_DATE_KEY = "videomaking.email-submission.prompt-date.v1";

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function loadStoredEmailSubmission(): StoredEmailSubmission | null {
  try {
    const raw = localStorage.getItem(SUBMITTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEmailSubmission>;
    if (typeof parsed.email !== "string" || !parsed.email.includes("@")) return null;
    return {
      email: parsed.email,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      submittedAt: typeof parsed.submittedAt === "number" ? parsed.submittedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveStoredEmailSubmission(input: { email: string; name?: string }): void {
  try {
    localStorage.setItem(
      SUBMITTED_KEY,
      JSON.stringify({
        email: input.email.trim().toLowerCase(),
        name: input.name?.trim() || undefined,
        submittedAt: Date.now(),
      }),
    );
    window.dispatchEvent(new CustomEvent("videomaking:email-submission-changed"));
  } catch {
    // Ignore browsers that block storage; the server submission still succeeds.
  }
}

export function shouldShowDailyEmailPrompt(): boolean {
  try {
    if (loadStoredEmailSubmission()) return false;
    return localStorage.getItem(PROMPT_DATE_KEY) !== todayKey();
  } catch {
    return !loadStoredEmailSubmission();
  }
}

export function markDailyEmailPromptShown(): void {
  try {
    localStorage.setItem(PROMPT_DATE_KEY, todayKey());
  } catch {
    // Ignore storage failures.
  }
}
