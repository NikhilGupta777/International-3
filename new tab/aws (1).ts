import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";
import type { KathaReference } from "./types";

const region = process.env.AWS_REGION || "ap-south-1";
const bucket = process.env.S3_BUCKET || "malikaeditorr";
const table = process.env.DYNAMODB_TABLE || "ytgrabber-green-jobs";
const refPrefix = process.env.KATHA_REF_PREFIX || "katha/references/";
const queryPrefix = process.env.KATHA_QUERY_PREFIX || "katha/query/";
const publicBaseUrl = process.env.KATHA_PUBLIC_BASE_URL || process.env.CLOUDFRONT_PUBLIC_BASE_URL || "";

export const s3 = new S3Client({ region });
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

export function makeId() {
  return crypto.randomUUID();
}

export function publicUrlForKey(key: string) {
  if (publicBaseUrl) return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export async function createUploadUrl(type: "reference" | "query", contentType: string) {
  const id = makeId();
  const prefix = type === "reference" ? refPrefix : queryPrefix;
  const key = `${prefix}${id}.jpg`;
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
  return { uploadUrl, s3Key: key, publicUrl: publicUrlForKey(key) };
}

export async function listReferences(): Promise<KathaReference[]> {
  const result = await ddb.send(new ScanCommand({
    TableName: table,
    FilterExpression: "#type = :type",
    ExpressionAttributeNames: { "#type": "type" },
    ExpressionAttributeValues: { ":type": "katha_reference" },
  }));
  return ((result.Items || []) as KathaReference[]).sort((a, b) => a.place_name.localeCompare(b.place_name) || +new Date(b.created_at) - +new Date(a.created_at));
}

export async function putReference(input: { place_name: string; location?: string | null; notes?: string | null; s3_key: string }) {
  const id = makeId();
  const reference: KathaReference & { pk: string; sk: string; type: string } = {
    pk: `KATHA_REF#${id}`,
    sk: "META",
    type: "katha_reference",
    id,
    place_name: input.place_name,
    location: input.location || null,
    notes: input.notes || null,
    s3_key: input.s3_key,
    image_url: publicUrlForKey(input.s3_key),
    created_at: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: table, Item: reference }));
  return reference;
}

export async function deleteReference(id: string) {
  const refs = await listReferences();
  const ref = refs.find((item) => item.id === id);
  if (!ref) return;
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: ref.s3_key }));
  await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: `KATHA_REF#${id}`, sk: "META" } }));
}

export async function deletePlace(placeName: string) {
  const refs = (await listReferences()).filter((ref) => ref.place_name === placeName);
  await Promise.all(refs.map((ref) => deleteReference(ref.id)));
}

export async function updatePlace(input: { old_place_name: string; place_name: string; location?: string | null; notes?: string | null }) {
  const refs = (await listReferences()).filter((ref) => ref.place_name === input.old_place_name);
  await Promise.all(refs.map((ref) => ddb.send(new UpdateCommand({
    TableName: table,
    Key: { pk: `KATHA_REF#${ref.id}`, sk: "META" },
    UpdateExpression: "SET place_name = :place, #location = :location, notes = :notes",
    ExpressionAttributeNames: { "#location": "location" },
    ExpressionAttributeValues: {
      ":place": input.place_name,
      ":location": input.location || null,
      ":notes": input.notes || null,
    },
  }))));
}

export async function objectToDataUrl(key: string) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await obj.Body?.transformToByteArray();
  if (!bytes) throw new Error(`Could not read ${key}`);
  const contentType = obj.ContentType || "image/jpeg";
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}
