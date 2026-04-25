export type RefItem = {
  id: string;
  place_name: string;
  location?: string | null;
  notes?: string | null;
  image_url: string;
  s3_key?: string;
  created_at?: string;
};

export type KathaReference = Required<Pick<RefItem, "id" | "place_name" | "image_url">> & {
  location: string | null;
  notes: string | null;
  s3_key: string;
  created_at: string;
};
