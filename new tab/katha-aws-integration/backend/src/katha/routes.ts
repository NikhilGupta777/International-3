import { Router } from "express";
import { createUploadUrl, deletePlace, deleteReference, listReferences, objectToDataUrl, putReference, updatePlace } from "./aws";
import { identifyKatha } from "./identify";

export const kathaRouter = Router();

function asyncRoute(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}

kathaRouter.get("/references", asyncRoute(async (_req, res) => {
  const references = await listReferences();
  res.json({ references });
}));

kathaRouter.post("/references", asyncRoute(async (req, res) => {
  const { place_name, location = null, notes = null, s3_key } = req.body || {};
  if (!place_name || !s3_key) return res.status(400).json({ error: "place_name and s3_key are required" });
  const reference = await putReference({ place_name: String(place_name).trim(), location, notes, s3_key });
  res.status(201).json({ reference });
}));

kathaRouter.patch("/references/place", asyncRoute(async (req, res) => {
  const { old_place_name, place_name, location = null, notes = null } = req.body || {};
  if (!old_place_name || !place_name) return res.status(400).json({ error: "old_place_name and place_name are required" });
  await updatePlace({ old_place_name, place_name, location, notes });
  res.json({ ok: true });
}));

kathaRouter.delete("/references/place/:placeName", asyncRoute(async (req, res) => {
  await deletePlace(decodeURIComponent(req.params.placeName));
  res.json({ ok: true });
}));

kathaRouter.delete("/references/:id", asyncRoute(async (req, res) => {
  await deleteReference(req.params.id);
  res.json({ ok: true });
}));

kathaRouter.post("/upload-url", asyncRoute(async (req, res) => {
  const { type, contentType = "image/jpeg" } = req.body || {};
  if (!["reference", "query"].includes(type)) return res.status(400).json({ error: "type must be reference or query" });
  const signed = await createUploadUrl(type, contentType);
  res.json(signed);
}));

kathaRouter.post("/identify", asyncRoute(async (req, res) => {
  const { queryImage, query_s3_key, references } = req.body || {};
  const refs = Array.isArray(references) && references.length ? references : await listReferences();
  const image = queryImage || (query_s3_key ? await objectToDataUrl(query_s3_key) : null);
  if (!image) return res.status(400).json({ error: "queryImage or query_s3_key is required" });
  const result = await identifyKatha(image, refs);
  res.json(result);
}));

kathaRouter.use((err: any, _req: any, res: any, _next: any) => {
  console.error("katha api error", err);
  const status = err.status || 500;
  let message = err.message || "Katha API failed";
  if (status === 429) message = "Gemini rate limit exceeded. Please try again shortly.";
  if (status === 402) message = "AI credits or billing issue on Gemini API.";
  res.status(status).json({ error: message });
});
