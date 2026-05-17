import { Bell, BellOff, LogOut, Mail, Moon, Settings, Sun, UserCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AuthFeatures, AuthUser } from "@/pages/Home";
import { cn } from "@/lib/utils";
import {
  applyThemePreference,
  loadUserPreferences,
  saveUserPreferences,
  type StudioThemePreference,
} from "@/lib/user-preferences";

export function SettingsPanel({
  authUser,
  authFeatures,
  onLogout,
  onOpenAdmin,
  onEnablePush,
  onTestSound,
  pushSupported,
  pushConfigured,
  pushPermission,
  pushEnabling,
  emailFocus,
  submittedEmail,
  onEmailSubmitted,
}: {
  authUser?: AuthUser | null;
  authFeatures?: AuthFeatures | null;
  onLogout?: () => void;
  onOpenAdmin?: () => void;
  onEnablePush?: () => void;
  onTestSound?: () => void;
  pushSupported?: boolean;
  pushConfigured?: boolean;
  pushPermission?: NotificationPermission | "unsupported";
  pushEnabling?: boolean;
  emailFocus?: boolean;
  submittedEmail?: string;
  onEmailSubmitted?: (email: string, name: string) => void;
}) {
  const [prefs, setPrefs] = useState(loadUserPreferences);
  const [emailValue, setEmailValue] = useState(authUser?.email ?? submittedEmail ?? "");
  const [nameValue, setNameValue] = useState(authUser?.name ?? "");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ text: string; error: boolean }>({
    text: submittedEmail ? `Saved: ${submittedEmail}` : "",
    error: false,
  });
  const displayName =
    authUser?.name?.trim() ||
    authUser?.email?.trim() ||
    (authUser?.method === "google" ? "Google user" : "Studio user");
  const isAdmin = authUser?.role === "admin";
  const emailAlreadySubmitted = Boolean(submittedEmail);

  useEffect(() => {
    applyThemePreference(prefs.theme);
  }, [prefs.theme]);

  const updatePrefs = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveUserPreferences(next);
  };

  const setTheme = (theme: StudioThemePreference) => updatePrefs({ theme });
  const submitFutureAccessEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (emailAlreadySubmitted) return;
    setEmailSaving(true);
    setEmailMsg({ text: "", error: false });
    try {
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/email-submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: emailValue, name: nameValue }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        submission?: { email?: string };
      };
      if (!res.ok) throw new Error(data.error || "Could not save email");
      const savedEmail = data.submission?.email || emailValue.trim().toLowerCase();
      onEmailSubmitted?.(savedEmail, nameValue.trim());
      setEmailMsg({ text: "Email saved for future access.", error: false });
    } catch (err) {
      setEmailMsg({
        text: err instanceof Error ? err.message : "Could not save email",
        error: true,
      });
    } finally {
      setEmailSaving(false);
    }
  };
  const notificationState =
    !pushSupported
      ? "Unsupported"
      : pushPermission === "granted"
        ? "Allowed"
        : pushPermission === "denied"
          ? "Blocked"
          : pushConfigured
            ? "Needs permission"
            : "Not configured";

  return (
    <div className="activity-page">
      <div className="activity-page-inner">
        <header className="activity-page-header">
          <div className="activity-page-icon">
            <Settings className="w-5 h-5 text-amber-300" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-white/35 font-semibold">Account</p>
            <h1 className="text-2xl md:text-3xl font-bold text-white">Settings</h1>
            <p className="text-sm text-white/45 mt-1">Profile, access, and session controls.</p>
          </div>
        </header>

        <section className="settings-profile-card">
          <div className="settings-avatar">
            {authUser?.picture ? (
              <img src={authUser.picture} alt="" className="w-full h-full rounded-2xl object-cover" referrerPolicy="no-referrer" />
            ) : (
              <UserCircle2 className="w-10 h-10 text-white/70" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold text-white truncate">{displayName}</p>
            <p className="text-sm text-white/45 truncate">{authUser?.email || "Password login"}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <span className="settings-chip">{authUser?.method === "google" ? "Google sign-in" : "Password sign-in"}</span>
              <span className="settings-chip">{isAdmin ? "Admin" : "User"}</span>
            </div>
          </div>
        </section>

        <form
          id="future-access-email"
          className={cn("settings-card settings-email-card", emailFocus && "settings-email-card--focus")}
          onSubmit={submitFutureAccessEmail}
        >
          <div className="flex items-center gap-2 mb-3">
            <Mail className="w-4 h-4 text-amber-300" />
            <h2 className="text-sm font-semibold text-white/85">Future access email</h2>
          </div>
          <p className="text-sm text-white/50 leading-relaxed mb-4">
            Username/password login will stop working on May 25, 2026. Submit the personal email you want to use for future access. All through the grace of Mahaprabhu Ji and Maa Radha Rani.
          </p>
          <div className="settings-email-form">
            <input
              type="text"
              value={nameValue}
              onChange={(event) => setNameValue(event.target.value)}
              placeholder="Your name"
              autoComplete="name"
              disabled={emailAlreadySubmitted}
              required
            />
            <input
              type="email"
              value={emailValue}
              onChange={(event) => setEmailValue(event.target.value)}
              placeholder="you@gmail.com"
              autoComplete="email"
              disabled={emailAlreadySubmitted}
              required
            />
            <button type="submit" disabled={emailAlreadySubmitted || emailSaving || !nameValue.trim() || !emailValue.trim()}>
              {emailAlreadySubmitted ? "Submitted" : emailSaving ? "Saving..." : "Submit name and email"}
            </button>
          </div>
          {emailMsg.text ? (
            <p className={emailMsg.error ? "settings-error" : "settings-success"}>
              {emailMsg.text}
            </p>
          ) : null}
        </form>

        <section className="settings-grid">
          <div className="settings-card">
            <div className="flex items-center gap-2 mb-4">
              <LogOut className="w-4 h-4 text-rose-300" />
              <h2 className="text-sm font-semibold text-white/85">Session</h2>
            </div>
            <p className="text-sm text-white/45 leading-relaxed mb-5">
              Logout clears this browser session and returns to the secure sign-in screen.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              {isAdmin && authFeatures?.adminPanelEnabled ? (
                <button type="button" className="settings-action-btn" onClick={onOpenAdmin}>
                  Open Admin
                </button>
              ) : null}
              <button type="button" className="settings-danger-btn" onClick={onLogout}>
                Logout
              </button>
            </div>
          </div>

          <div className="settings-card">
            <div className="flex items-center gap-2 mb-4">
              {prefs.theme === "light" ? <Sun className="w-4 h-4 text-amber-300" /> : <Moon className="w-4 h-4 text-sky-300" />}
              <h2 className="text-sm font-semibold text-white/85">Appearance</h2>
            </div>
            <p className="text-sm text-white/45 leading-relaxed mb-4">
              Choose how the studio looks on this device.
            </p>
            <div className="settings-segment">
              {(["dark", "light", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={prefs.theme === theme ? "is-active" : ""}
                  onClick={() => setTheme(theme)}
                >
                  {theme}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-card">
            <div className="flex items-center gap-2 mb-4">
              {prefs.notificationsEnabled ? <Bell className="w-4 h-4 text-teal-300" /> : <BellOff className="w-4 h-4 text-white/40" />}
              <h2 className="text-sm font-semibold text-white/85">Notifications</h2>
            </div>
            <div className="settings-row">
              <span>Browser notifications</span>
              <strong>{notificationState}</strong>
            </div>
            <label className="settings-toggle-row">
              <span>
                <strong>Completion alerts</strong>
                <small>Show browser alerts when jobs finish in background.</small>
              </span>
              <input
                type="checkbox"
                checked={prefs.notificationsEnabled}
                onChange={(event) => {
                  updatePrefs({ notificationsEnabled: event.target.checked });
                  if (event.target.checked && pushPermission !== "granted") onEnablePush?.();
                }}
              />
            </label>
            <label className="settings-toggle-row">
              <span>
                <strong>Notification sound</strong>
                <small>Play the Replit-style agent chime on completion.</small>
              </span>
              <input
                type="checkbox"
                checked={prefs.notificationSoundEnabled}
                onChange={(event) => updatePrefs({ notificationSoundEnabled: event.target.checked })}
              />
            </label>
            <div className="flex flex-col sm:flex-row gap-3 mt-4">
              <button
                type="button"
                className="settings-action-btn"
                onClick={onEnablePush}
                disabled={pushEnabling || !pushSupported}
              >
                {pushEnabling ? "Enabling..." : "Enable notifications"}
              </button>
              <button
                type="button"
                className="settings-action-btn"
                onClick={onTestSound}
                disabled={!prefs.notificationSoundEnabled}
              >
                Test sound
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
