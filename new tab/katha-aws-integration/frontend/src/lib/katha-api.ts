export type KathaReference = {
  id: string;
  place_name: string;
  location?: string | null;
  notes?: string | null;
  image_url: string;
  s3_key: string;
  created_at: string;
};

export type KathaMatch = {
  reference_index: number;
  confidence: number;
  matched_features: string[];
  reference: KathaReference | null;
};

export type IdentifyResponse = {
  matches: KathaMatch[];
  overall_analysis: string;
  shortlisted: boolean;
  total_references: number;
  candidates_evaluated: number;
  elapsed_ms: number;
};

export const MAX_FILE_MB = 15;
export const MAX_BATCH_FILES = 100;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

export async function listKathaReferences() {
  return jsonFetch<{ references: KathaReference[] }>("/api/katha/references");
}

export async function createKathaReference(input: {
  place_name: string;
  location?: string | null;
  notes?: string | null;
  s3_key: string;
}) {
  return jsonFetch<{ reference: KathaReference }>("/api/katha/references", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateKathaPlace(input: {
  old_place_name: string;
  place_name: string;
  location?: string | null;
  notes?: string | null;
}) {
  return jsonFetch<{ ok: true }>("/api/katha/references/place", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteKathaReference(id: string) {
  return jsonFetch<{ ok: true }>(`/api/katha/references/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteKathaPlace(placeName: string) {
  return jsonFetch<{ ok: true }>(`/api/katha/references/place/${encodeURIComponent(placeName)}`, { method: "DELETE" });
}

export async function getKathaUploadUrl(input: { type: "reference" | "query"; contentType: string }) {
  return jsonFetch<{ uploadUrl: string; s3Key: string; publicUrl: string }>("/api/katha/upload-url", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function uploadToSignedUrl(uploadUrl: string, blob: Blob, contentType = "image/jpeg") {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!res.ok) throw new Error(`S3 upload failed (${res.status})`);
}

export async function identifyKatha(queryImage: string, references: KathaReference[]) {
  return jsonFetch<IdentifyResponse>("/api/katha/identify", {
    method: "POST",
    body: JSON.stringify({ queryImage, references }),
  });
}
