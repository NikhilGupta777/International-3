import { Switch, Route, Router as WouterRouter } from "wouter";
import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
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
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const res = await fetch(`${base}/api/auth/session`, {
          credentials: "include",
        });
        if (!mounted) return;
        if (res.ok) {
          const data = (await res.json()) as { authenticated?: boolean };
          setAuthenticated(Boolean(data.authenticated));
        } else {
          setAuthenticated(false);
        }
      } catch {
        setAuthenticated(false);
      } finally {
        if (mounted) setAuthChecked(true);
      }
    };
    void check();
    return () => {
      mounted = false;
    };
  }, [base]);

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
      setAuthenticated(true);
    } catch {
      setLoginError("Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="relative min-h-screen">
          {!authChecked ? (
            <AuthOverlay
              eyebrow="Secure Access"
              title="Loading VideoMaking Studio"
              subtitle="Verifying session..."
              compact
            />
          ) : authenticated ? (
            <WouterRouter base={base} key="auth">
              <Router />
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
            </AuthOverlay>
          )}
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
