import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import {
  installNotifyClientHeader,
  registerPushServiceWorker,
} from "@/lib/push-notifications";
import "./index.css";

installNotifyClientHeader();
void registerPushServiceWorker();

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
