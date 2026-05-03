import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

interface UseInstallPromptReturn {
  /** True when the browser has a deferred install prompt ready */
  canInstall: boolean;
  /** True while the install dialog is open */
  isInstalling: boolean;
  /** True once the user has installed (or dismissed permanently) */
  isInstalled: boolean;
  /** Call this to trigger the native install prompt */
  triggerInstall: () => Promise<void>;
  /** Dismiss the banner without installing */
  dismiss: () => void;
}

const DISMISSED_KEY = "vmstudio.pwa-install-dismissed";

export function useInstallPrompt(): UseInstallPromptReturn {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Already running as installed PWA
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setIsInstalled(true);
      return;
    }

    // User previously dismissed the banner
    if (localStorage.getItem(DISMISSED_KEY) === "1") {
      setDismissed(true);
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", () => setIsInstalled(true));

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  // Register / update our SW
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => console.warn("[SW] Registration failed:", err));
    }
  }, []);

  const triggerInstall = async () => {
    if (!deferredPrompt) return;
    setIsInstalling(true);
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        setIsInstalled(true);
        setDeferredPrompt(null);
      }
    } finally {
      setIsInstalling(false);
    }
  };

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  return {
    canInstall: !!deferredPrompt && !isInstalled && !dismissed,
    isInstalling,
    isInstalled,
    triggerInstall,
    dismiss,
  };
}
