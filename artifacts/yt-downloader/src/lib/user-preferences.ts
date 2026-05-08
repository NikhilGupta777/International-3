export type StudioThemePreference = "dark" | "light" | "system";

export type UserPreferences = {
  theme: StudioThemePreference;
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
};

const PREF_KEY = "videomaking.user-preferences.v1";

const DEFAULT_PREFS: UserPreferences = {
  theme: "dark",
  notificationsEnabled: true,
  notificationSoundEnabled: true,
};

function isTheme(value: unknown): value is StudioThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function loadUserPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_PREFS.theme,
      notificationsEnabled:
        typeof parsed.notificationsEnabled === "boolean"
          ? parsed.notificationsEnabled
          : DEFAULT_PREFS.notificationsEnabled,
      notificationSoundEnabled:
        typeof parsed.notificationSoundEnabled === "boolean"
          ? parsed.notificationSoundEnabled
          : DEFAULT_PREFS.notificationSoundEnabled,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveUserPreferences(next: UserPreferences): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("videomaking:preferences-changed", { detail: next }));
  } catch {}
}

export function applyThemePreference(theme: StudioThemePreference): void {
  const root = document.documentElement;
  const prefersLight =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const resolved = theme === "system" ? (prefersLight ? "light" : "dark") : theme;

  root.dataset.studioTheme = theme;
  root.classList.toggle("studio-light-mode", resolved === "light");
  root.classList.toggle("studio-dark-mode", resolved !== "light");
}

export function subscribeToPreferenceChanges(callback: (prefs: UserPreferences) => void): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<UserPreferences>;
    callback(custom.detail ?? loadUserPreferences());
  };
  window.addEventListener("videomaking:preferences-changed", handler);
  return () => window.removeEventListener("videomaking:preferences-changed", handler);
}
