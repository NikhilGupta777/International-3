// Shared types used across the Katha identifier UI.
export type Reference = {
  id: string;
  place_name: string;
  location: string | null;
  notes: string | null;
  image_url: string;
  storage_path: string;
  created_at: string;
};

export type MatchResult = {
  reference_index: number;
  confidence: number;
  matched_features: string[];
  reference: Reference | null;
};

export type IdentifyMeta = {
  shortlisted?: boolean;
  total?: number;
  evaluated?: number;
  elapsed_ms?: number;
};

export const BUCKET = "katha-images";
export const MAX_FILE_MB = 15;
export const MAX_BATCH_FILES = 100;
