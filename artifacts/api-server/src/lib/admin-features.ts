import { normalizeEmail } from "./auth-access";

export type RuntimeFeatureKey = "translatorLipSyncEnabled";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function enabled(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

function parseEmailSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => normalizeEmail(item)),
  );
}

const runtimeFeatures: Record<RuntimeFeatureKey, boolean> = {
  translatorLipSyncEnabled: enabled(process.env.TRANSLATOR_LIP_SYNC_ENABLED),
};

const lipSyncAllowedEmails = parseEmailSet(process.env.TRANSLATOR_LIP_SYNC_ALLOWED_EMAILS);

export function getRuntimeFeatureState() {
  return {
    features: { ...runtimeFeatures },
    permissions: {
      translatorLipSyncAllowedEmails: Array.from(lipSyncAllowedEmails).sort(),
    },
  };
}

export function setRuntimeFeature(key: RuntimeFeatureKey, enabledValue: boolean) {
  runtimeFeatures[key] = enabledValue;
  return getRuntimeFeatureState();
}

export function setTranslatorLipSyncEmail(email: string, allowed: boolean) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Invalid email");
  if (allowed) lipSyncAllowedEmails.add(normalized);
  else lipSyncAllowedEmails.delete(normalized);
  return getRuntimeFeatureState();
}

export function isTranslatorLipSyncEnabled(): boolean {
  return runtimeFeatures.translatorLipSyncEnabled;
}

export function canUseTranslatorLipSync(email?: string): boolean {
  if (!isTranslatorLipSyncEnabled()) return false;
  if (!email) return false;
  return lipSyncAllowedEmails.has(normalizeEmail(email));
}
