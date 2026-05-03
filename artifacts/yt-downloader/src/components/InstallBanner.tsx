import { useInstallPrompt } from "@/hooks/use-install-prompt";

/**
 * InstallBanner — fixed bottom bar that appears when the browser supports PWA
 * install. Animates in from the bottom, lets users install the app or dismiss.
 */
export function InstallBanner() {
  const { canInstall, isInstalling, triggerInstall, dismiss } = useInstallPrompt();

  if (!canInstall) return null;

  return (
    <>
      {/* Backdrop blur faint overlay at the very bottom */}
      <div className="install-banner-root" role="region" aria-label="Install app">
        <div className="install-banner-inner">
          {/* Left: icon + text */}
          <div className="install-banner-info">
            <img
              src="/app-logo.png"
              alt="VideoMaking Studio"
              className="install-banner-icon"
              draggable={false}
            />
            <div className="install-banner-text">
              <span className="install-banner-title">Add to Home Screen</span>
              <span className="install-banner-subtitle">
                Install VideoMaking Studio for quick access
              </span>
            </div>
          </div>

          {/* Right: buttons */}
          <div className="install-banner-actions">
            <button
              id="pwa-install-btn"
              className="install-banner-btn install-banner-btn--primary"
              onClick={triggerInstall}
              disabled={isInstalling}
              aria-label="Install app"
            >
              {isInstalling ? (
                <span className="install-banner-spinner" aria-hidden="true" />
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              )}
              {isInstalling ? "Installing…" : "Install App"}
            </button>

            <button
              id="pwa-dismiss-btn"
              className="install-banner-btn install-banner-btn--ghost"
              onClick={dismiss}
              aria-label="Dismiss install prompt"
              title="Not now"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
