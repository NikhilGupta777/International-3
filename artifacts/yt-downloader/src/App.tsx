import { Switch, Route, Router as WouterRouter } from "wouter";
import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home, { type AuthFeatures, type AuthUser } from "@/pages/Home";
import NotFound from "@/pages/not-found";
import { cn } from "@/lib/utils";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const AUTH_HINT_KEY = "videomaking.authenticated";

type AuthConfig = {
  googleAuthEnabled: boolean;
  googleClientId: string;
};

type AuthSessionResponse = {
  authenticated?: boolean;
  user?: AuthUser | null;
  features?: AuthFeatures | null;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: { client_id: string; callback: (response: { credential?: string }) => void }) => void;
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
          prompt: () => void;
        };
      };
    };
  }
}

function Router({
  authUser,
  authFeatures,
}: {
  authUser: AuthUser | null;
  authFeatures: AuthFeatures | null;
}) {
  return (
    <Switch>
      <Route path="/">
        <Home authUser={authUser} authFeatures={authFeatures} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthOverlay({
  eyebrow,
  title,
  subtitle,
  children,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  const overlay = (
    <div className="auth-overlay">
      <div className="auth-overlay-inner">
        <section className={`auth-card${compact ? " auth-card--compact" : ""}`}>
          <p className="auth-eyebrow">{eyebrow}</p>
          <h1 className="auth-title">{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>
          {children}
        </section>
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return overlay;
  }

  return createPortal(overlay, document.body);
}

function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AUTH_HINT_KEY) === "1";
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authFeatures, setAuthFeatures] = useState<AuthFeatures | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    let mounted = true;
    const hadAuthHint =
      typeof window !== "undefined" &&
      window.localStorage.getItem(AUTH_HINT_KEY) === "1";
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const check = async () => {
      let sessionOk = false;
      let sawDefiniteUnauthenticated = false;
      try {
        const maxAttempts = hadAuthHint ? 3 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const res = await fetch(`${base}/api/auth/session`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!mounted) return;
          if (res.ok) {
            const data = (await res.json()) as AuthSessionResponse;
            setAuthFeatures(data.features ?? null);
            if (data.authenticated) {
              sessionOk = true;
              setAuthUser(data.user ?? { method: "password", role: "admin" });
              break;
            }
            setAuthUser(null);
            sawDefiniteUnauthenticated = true;
          }
          if (attempt < maxAttempts - 1) {
            await delay(350);
          }
        }
      } catch {
        sawDefiniteUnauthenticated = false;
      } finally {
        if (!mounted) return;
        if (sessionOk) {
          window.localStorage.setItem(AUTH_HINT_KEY, "1");
          setAuthenticated(true);
        } else if (hadAuthHint && !sawDefiniteUnauthenticated) {
          window.localStorage.setItem(AUTH_HINT_KEY, "1");
          setAuthenticated(true);
        } else {
          window.localStorage.removeItem(AUTH_HINT_KEY);
          setAuthenticated(false);
          setAuthUser(null);
        }
        setAuthChecked(true);
      }
    };
    void check();
    return () => {
      mounted = false;
    };
  }, [base]);

  useEffect(() => {
    let mounted = true;
    const loadConfig = async () => {
      try {
        const res = await fetch(`${base}/api/auth/config`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as AuthConfig;
        if (mounted) setAuthConfig(data);
      } catch {
        // Google sign-in stays hidden if config cannot be loaded.
      }
    };
    void loadConfig();
    return () => {
      mounted = false;
    };
  }, [base]);

  useEffect(() => {
    if (!authConfig?.googleAuthEnabled || !authConfig.googleClientId || authenticated) return;
    if (window.google?.accounts?.id) {
      setGoogleReady(true);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>("script[data-google-identity]");
    if (existing) {
      existing.addEventListener("load", () => setGoogleReady(true), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => setGoogleReady(true);
    document.head.appendChild(script);
  }, [authConfig, authenticated]);

  useEffect(() => {
    if (!googleReady || !authConfig?.googleAuthEnabled || !authConfig.googleClientId || authenticated) return;
    const target = document.getElementById("google-signin-button");
    const googleId = window.google?.accounts?.id;
    if (!target || !googleId || target.childElementCount > 0) return;

    googleId.initialize({
      client_id: authConfig.googleClientId,
      callback: (response) => {
        if (response.credential) {
          void submitGoogleLogin(response.credential);
        }
      },
    });
    googleId.renderButton(target, {
      theme: "filled_black",
      size: "large",
      width: "100%",
      text: "continue_with",
    });
  }, [googleReady, authConfig, authenticated]);

  const submitLogin = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setLoginError("");
    try {
      const loginUrl = `${base}/api/auth/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      const res = await fetch(loginUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setLoginError("Invalid username or password");
        return;
      }
      window.localStorage.setItem(AUTH_HINT_KEY, "1");
      setAuthUser({ method: "password", role: "admin" });
      setAuthenticated(true);
      setAuthChecked(true);
    } catch {
      setLoginError("Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitGoogleLogin = async (credential: string) => {
    setGoogleSubmitting(true);
    setLoginError("");
    try {
      const res = await fetch(`${base}/api/auth/google`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const data = (await res.json().catch(() => null)) as { user?: AuthUser; error?: string } | null;
      if (!res.ok) {
        setLoginError(data?.error || "Google sign-in failed");
        return;
      }
      window.localStorage.setItem(AUTH_HINT_KEY, "1");
      setAuthUser(data?.user ?? { method: "google", role: "user" });
      setAuthenticated(true);
      setAuthChecked(true);
    } catch {
      setLoginError("Google sign-in failed. Please try again.");
    } finally {
      setGoogleSubmitting(false);
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="relative h-full w-full">
          {!authChecked ? (
            <AuthOverlay
              eyebrow="Secure Access"
              title="Loading VideoMaking Studio"
              subtitle="Verifying session..."
              compact
            />
          ) : authenticated ? (
            <WouterRouter base={base} key="auth">
              <Router authUser={authUser} authFeatures={authFeatures} />
            </WouterRouter>
          ) : (
            <AuthOverlay
              eyebrow="Welcome"
              title="Greetings to Narayani Sena"
              subtitle="All Narayan bhakt are welcome."
            >
              <p className="auth-help">
                Enter your access credentials to continue.
              </p>

              <form onSubmit={submitLogin} className="auth-form">
                <input
                  className="auth-input"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
                <input
                  className="auth-input"
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                {loginError ? (
                  <p className="auth-error">{loginError}</p>
                ) : null}
                <button className="auth-button" type="submit" disabled={submitting}>
                  {submitting ? "Entering..." : "Enter Studio"}
                </button>
              </form>

              {authConfig?.googleAuthEnabled && authConfig.googleClientId ? (
                <div className="auth-google-wrap">
                  <div id="google-signin-button" className={cn("auth-google-button", googleSubmitting && "opacity-60 pointer-events-none")} />
                  {googleSubmitting ? <p className="auth-help">Checking Google approval...</p> : null}
                </div>
              ) : null}
            </AuthOverlay>
          )}
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
