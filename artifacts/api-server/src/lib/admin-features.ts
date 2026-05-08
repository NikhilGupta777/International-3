import { normalizeEmail } from "./auth-access";

export type RuntimeFeatureKey =
  | "translatorEnabled"
  | "translatorLipSyncEnabled"
  | "superAgentEnabled";

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
  translatorEnabled: enabled(process.env.TRANSLATOR_ENABLED, true),
  translatorLipSyncEnabled: enabled(process.env.TRANSLATOR_LIP_SYNC_ENABLED),
  superAgentEnabled: enabled(process.env.SUPER_AGENT_ENABLED, true),
};

const translatorAllowedEmails = parseEmailSet(process.env.TRANSLATOR_ALLOWED_EMAILS);
const lipSyncAllowedEmails = parseEmailSet(process.env.TRANSLATOR_LIP_SYNC_ALLOWED_EMAILS);
const superAgentAllowedEmails = parseEmailSet(process.env.SUPER_AGENT_ALLOWED_EMAILS);

export function getRuntimeFeatureState() {
  return {
    features: { ...runtimeFeatures },
    permissions: {
      translatorAllowedEmails: Array.from(translatorAllowedEmails).sort(),
      translatorLipSyncAllowedEmails: Array.from(lipSyncAllowedEmails).sort(),
      superAgentAllowedEmails: Array.from(superAgentAllowedEmails).sort(),
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

function setPermissionEmail(set: Set<string>, email: string, allowed: boolean) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Invalid email");
  if (allowed) set.add(normalized);
  else set.delete(normalized);
  return getRuntimeFeatureState();
}

export function setTranslatorEmail(email: string, allowed: boolean) {
  return setPermissionEmail(translatorAllowedEmails, email, allowed);
}

export function setSuperAgentEmail(email: string, allowed: boolean) {
  return setPermissionEmail(superAgentAllowedEmails, email, allowed);
}

export function isTranslatorLipSyncEnabled(): boolean {
  return runtimeFeatures.translatorLipSyncEnabled;
}

export function isTranslatorEnabled(): boolean {
  return runtimeFeatures.translatorEnabled;
}

export function isSuperAgentEnabled(): boolean {
  return runtimeFeatures.superAgentEnabled;
}

function canUseRestrictedFeature(enabledValue: boolean, emails: Set<string>, email?: string): boolean {
  if (!enabledValue) return false;
  if (emails.size === 0) return true;
  if (!email) return false;
  return emails.has(normalizeEmail(email));
}

export function canUseTranslator(email?: string): boolean {
  return canUseRestrictedFeature(isTranslatorEnabled(), translatorAllowedEmails, email);
}

export function canUseSuperAgent(email?: string): boolean {
  return canUseRestrictedFeature(isSuperAgentEnabled(), superAgentAllowedEmails, email);
}

export function canUseTranslatorLipSync(email?: string): boolean {
  if (!isTranslatorLipSyncEnabled()) return false;
  if (!email) return false;
  return lipSyncAllowedEmails.has(normalizeEmail(email));
}
