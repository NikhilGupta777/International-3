import { Bell, BellOff, LogOut, Moon, Settings, Sun, UserCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuthFeatures, AuthUser } from "@/pages/Home";
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
}) {
  const [prefs, setPrefs] = useState(loadUserPreferences);
  const displayName =
    authUser?.name?.trim() ||
    authUser?.email?.trim() ||
    (authUser?.method === "google" ? "Google user" : "Studio user");
  const isAdmin = authUser?.role === "admin";

  useEffect(() => {
    applyThemePreference(prefs.theme);
  }, [prefs.theme]);

  const updatePrefs = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveUserPreferences(next);
  };

  const setTheme = (theme: StudioThemePreference) => updatePrefs({ theme });

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
