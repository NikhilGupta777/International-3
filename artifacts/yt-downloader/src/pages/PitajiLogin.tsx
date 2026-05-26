import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { loginPitaji } from "@/lib/pitaji-api";

interface Props {
  onAuthenticated: (username: string) => void;
  onSwitchWorkspace: () => void;
}

/**
 * Pita Ji workspace login screen.
 *
 * Visually distinct from the VideoMaking login: dark devotional palette
 * (deep saffron / gold accent on near-black), id + password only — no Google
 * sign-in. Lives in its own overlay portal so it never overlaps the main app.
 */
export default function PitajiLogin({ onAuthenticated, onSwitchWorkspace }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const usernameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Auto-focus username on mount for fast typing.
    const t = window.setTimeout(() => usernameRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await loginPitaji(username.trim(), password);
      onAuthenticated(res.user?.username ?? username.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  const overlay = (
    <div className="pj-auth-overlay" data-pitaji-login>
      <div className="pj-auth-bg" aria-hidden />
      <div className="pj-auth-inner">
        <section className="pj-auth-card">
          <div className="pj-auth-mark" aria-hidden>
            <span>ॐ</span>
          </div>
          <p className="pj-auth-eyebrow">Pita Ji Live</p>
          <h1 className="pj-auth-title">Jai Shri Krishna</h1>
          <p className="pj-auth-subtitle">Enter the dedicated workspace for live-stream clip generation.</p>

          <form onSubmit={submit} className="pj-auth-form">
            <input
              ref={usernameRef}
              className="pj-auth-input"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              spellCheck={false}
            />
            <input
              className="pj-auth-input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            {error ? <p className="pj-auth-error">{error}</p> : null}
            <button className="pj-auth-button" type="submit" disabled={submitting}>
              {submitting ? "Entering…" : "Enter Pita Ji workspace"}
            </button>
          </form>

          <button
            type="button"
            className="pj-auth-switch"
            onClick={onSwitchWorkspace}
            disabled={submitting}
          >
            Back to VideoMaking Studio
          </button>
        </section>
      </div>
    </div>
  );

  if (typeof document === "undefined") return overlay;
  return createPortal(overlay, document.body);
}
