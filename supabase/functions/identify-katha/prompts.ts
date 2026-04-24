// Prompt builders + tool schemas for the katha identifier.
export interface RefItem {
  id: string;
  place_name: string;
  location: string | null;
  notes: string | null;
  image_url: string;
}

export const SYSTEM_INTRO = `You are an expert visual verification system for Bhagwat Katha event photographs.
The SAME speaker (vyas) appears in every photo — IGNORE the speaker, clothing, and microphone.
Focus ONLY on venue features:
- Vyas peeth (chair/throne) shape, carving, color, fabric
- Backdrop banner text/imagery, drapery, color scheme
- Floral decoration patterns, garland style
- Stage structure, pillars, idols, lighting fixtures
- Surrounding architecture and visible audience seating`;

export function buildShortlistMessage(queryImage: string, batch: RefItem[], offset: number) {
  const content: any[] = [
    {
      type: "text",
      text: `${SYSTEM_INTRO}

The FIRST image is the QUERY (a new unlabeled katha photo).
The next ${batch.length} images are REFERENCE candidates labeled [${offset}] through [${offset + batch.length - 1}].

Reference labels:
${batch.map((r, i) => `[${offset + i}] ${r.place_name}${r.location ? " — " + r.location : ""}`).join("\n")}

TASK: Score each reference 0-100 for how likely it is the SAME venue as the query (focus on venue features only). Return scores for ALL ${batch.length} references via the score_batch function.`,
    },
    { type: "image_url", image_url: { url: queryImage } },
  ];
  batch.forEach((r, i) => {
    content.push({ type: "text", text: `Reference [${offset + i}]: ${r.place_name}` });
    content.push({ type: "image_url", image_url: { url: r.image_url } });
  });
  return [{ role: "user", content }];
}

export function buildFinalMessage(queryImage: string, candidates: RefItem[]) {
  const content: any[] = [
    {
      type: "text",
      text: `${SYSTEM_INTRO}

The FIRST image is the QUERY. The next ${candidates.length} images are the TOP candidate references, labeled [0]..[${candidates.length - 1}].

Reference labels:
${candidates.map((r, i) => `[${i}] ${r.place_name}${r.location ? " — " + r.location : ""}${r.notes ? " (" + r.notes + ")" : ""}`).join("\n")}

TASK: Identify the TOP 3 best matches. For each, list at least 3 specific shared VENUE features (not the speaker). Provide an honest confidence (0-100). If none look like a confident match, still return the closest 3 with low confidences and say so in overall_analysis.`,
    },
    { type: "image_url", image_url: { url: queryImage } },
  ];
  candidates.forEach((r, i) => {
    content.push({ type: "text", text: `Reference [${i}]: ${r.place_name}` });
    content.push({ type: "image_url", image_url: { url: r.image_url } });
  });
  return [{ role: "user", content }];
}

export const SHORTLIST_TOOL = [{
  type: "function",
  function: {
    name: "score_batch",
    description: "Return similarity scores",
    parameters: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              reference_index: { type: "number" },
              score: { type: "number", description: "0-100 venue similarity" },
            },
            required: ["reference_index", "score"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores"],
      additionalProperties: false,
    },
  },
}];

export const FINAL_TOOL = [{
  type: "function",
  function: {
    name: "return_match",
    description: "Top 3 ranked matches",
    parameters: {
      type: "object",
      properties: {
        matches: {
          type: "array", minItems: 1, maxItems: 3,
          items: {
            type: "object",
            properties: {
              reference_index: { type: "number" },
              confidence: { type: "number" },
              matched_features: { type: "array", items: { type: "string" }, minItems: 3 },
            },
            required: ["reference_index", "confidence", "matched_features"],
            additionalProperties: false,
          },
        },
        overall_analysis: { type: "string" },
      },
      required: ["matches", "overall_analysis"],
      additionalProperties: false,
    },
  },
}];
