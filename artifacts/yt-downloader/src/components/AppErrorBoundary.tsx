import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
  componentStack: string;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, errorMessage: "", componentStack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const componentStack = info.componentStack?.trim() ?? "";
    console.error("Unhandled app render error", error, info);
    try {
      window.localStorage.setItem(
        "videomaking.lastRenderCrash",
        JSON.stringify({
          errorMessage,
          componentStack,
          url: window.location.href,
          at: new Date().toISOString(),
        }),
      );
    } catch {
      // Ignore storage failures; the visible crash card still shows the error.
    }
    this.setState({ errorMessage, componentStack });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleResetAndReload = async () => {
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((registrations ?? []).map((registration) => registration.unregister()));
    } catch {
      // Best-effort recovery.
    }
    try {
      const cacheKeys = await caches?.keys?.();
      await Promise.all((cacheKeys ?? []).map((key) => caches.delete(key)));
    } catch {
      // Best-effort recovery.
    }
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // Best-effort recovery.
    }
    window.location.href = "/";
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-background text-white flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-red-300" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-white/60">
              The page crashed unexpectedly. Reload to continue.
            </p>
          </div>
          {this.state.errorMessage ? (
            <div className="rounded-xl border border-red-400/20 bg-black/30 p-3 text-left">
              <p className="text-xs font-semibold uppercase tracking-wide text-red-200">
                Error
              </p>
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs text-red-100">
                {this.state.errorMessage}
              </pre>
              {this.state.componentStack ? (
                <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[11px] text-white/45">
                  {this.state.componentStack}
                </pre>
              ) : null}
            </div>
          ) : null}
          <Button
            onClick={this.handleReload}
            className="w-full rounded-xl h-10 text-sm font-semibold"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Reload App
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={this.handleResetAndReload}
            className="w-full rounded-xl h-10 text-sm font-semibold border-red-400/30 bg-transparent text-red-100 hover:bg-red-500/10"
          >
            Reset Browser Data
          </Button>
        </div>
      </div>
    );
  }
}
