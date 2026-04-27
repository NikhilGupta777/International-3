const TRANSLATOR_CLIENT_ID_KEY = "ytgrabber_translator_client_id";

function makeClientId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `translator-${Date.now().toString(36)}-${rand}`;
}

export function getTranslatorClientId(): string {
  try {
    const existing = localStorage.getItem(TRANSLATOR_CLIENT_ID_KEY);
    if (existing && existing.trim().length > 0) return existing;
    const created = makeClientId();
    localStorage.setItem(TRANSLATOR_CLIENT_ID_KEY, created);
    return created;
  } catch {
    return "translator-anon";
  }
}

export function translatorAuthHeaders(): HeadersInit {
  return { "x-client-id": getTranslatorClientId() };
}
