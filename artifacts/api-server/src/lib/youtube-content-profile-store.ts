import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ScrapedChannelProfile } from "./youtube-content-profile";

const KIND = "youtube-content-profile";
const OWNER = "__youtube_content_shared__";

function envTrim(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

const TABLE_NAME =
  envTrim("CONTENT_PROFILE_TABLE") ||
  envTrim("THUMBNAIL_PRESET_TABLE") ||
  envTrim("YOUTUBE_QUEUE_JOB_TABLE") ||
  "ytgrabber-green-jobs";

const REGION =
  envTrim("CONTENT_PROFILE_DDB_REGION") ||
  envTrim("YOUTUBE_QUEUE_REGION") ||
  envTrim("AWS_DEFAULT_REGION") ||
  envTrim("AWS_REGION") ||
  "us-east-1";

export type ContentProfileSummary = {
  id: string;
  name: string;
  channelInput: string;
  channelUrl?: string;
  videoCount: number;
  scrapedAt: number;
  updatedAt: number;
};

export type ContentProfileRecord = {
  jobId: string;
  kind: typeof KIND;
  owner: typeof OWNER;
  name: string;
  channelInput: string;
  profile: ScrapedChannelProfile;
  createdAt: number;
  updatedAt: number;
};

let dynamo: DynamoDBClient | null = null;

function client(): DynamoDBClient {
  dynamo ??= new DynamoDBClient({ region: REGION });
  return dynamo;
}

export function isContentProfileStoreEnabled(): boolean {
  return Boolean(TABLE_NAME);
}

export function newContentProfileId(): string {
  return `ycp_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function listContentProfiles(): Promise<ContentProfileSummary[]> {
  if (!isContentProfileStoreEnabled()) return [];

  try {
    const items: Record<string, AttributeValue>[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const out = await client().send(new ScanCommand({
        TableName: TABLE_NAME,
        ConsistentRead: true,
        ExclusiveStartKey,
        FilterExpression: "#kind = :kind AND #owner = :owner",
        ExpressionAttributeNames: {
          "#kind": "kind",
          "#owner": "owner",
        },
        ExpressionAttributeValues: {
          ":kind": { S: KIND },
          ":owner": { S: OWNER },
        },
      }));
      items.push(...(out.Items ?? []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const records = items
      .map(decodeRecord)
      .filter((record): record is ContentProfileRecord => Boolean(record));
    return summarizeRecords(mergeRecords(records, loadFileRecords()));
  } catch {
    return summarizeRecords(loadFileRecords());
  }
}

export async function getContentProfile(id: string): Promise<ContentProfileRecord | null> {
  if (!id || !isContentProfileStoreEnabled()) return null;
  try {
    const out = await client().send(new GetItemCommand({
      TableName: TABLE_NAME,
      ConsistentRead: true,
      Key: { jobId: { S: id } },
    }));
    return out.Item ? decodeRecord(out.Item) : loadFileRecords().find((record) => record.jobId === id) ?? null;
  } catch {
    return loadFileRecords().find((record) => record.jobId === id) ?? null;
  }
}

export async function upsertContentProfile(params: {
  id?: string;
  profile: ScrapedChannelProfile;
}): Promise<ContentProfileRecord> {
  const id = params.id && params.id.startsWith("ycp_") ? params.id : newContentProfileId();
  const now = Date.now();
  const existing = params.id ? await getContentProfile(params.id).catch(() => null) : null;
  const record: ContentProfileRecord = {
    jobId: id,
    kind: KIND,
    owner: OWNER,
    name: params.profile.channelName,
    channelInput: params.profile.channelInput,
    profile: params.profile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  try {
    await client().send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: encodeRecord(record),
    }));
    upsertFileRecord(record);
  } catch {
    upsertFileRecord(record);
  }
  return record;
}

export async function deleteContentProfile(id: string): Promise<boolean> {
  if (!id || !isContentProfileStoreEnabled()) return false;
  try {
    await client().send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: id } },
    }));
    return true;
  } catch {
    const records = loadFileRecords();
    const filtered = records.filter((record) => record.jobId !== id);
    if (filtered.length === records.length) return false;
    saveFileRecords(filtered);
    return true;
  }
}

function encodeRecord(record: ContentProfileRecord): Record<string, AttributeValue> {
  return {
    jobId: { S: record.jobId },
    kind: { S: KIND },
    owner: { S: OWNER },
    name: { S: record.name },
    channelInput: { S: record.channelInput },
    profile: { S: JSON.stringify(record.profile) },
    createdAt: { N: String(record.createdAt) },
    updatedAt: { N: String(record.updatedAt) },
  };
}

function decodeRecord(item: Record<string, AttributeValue>): ContentProfileRecord | null {
  const jobId = item.jobId?.S;
  const profileRaw = item.profile?.S;
  if (!jobId || !profileRaw) return null;
  try {
    const profile = JSON.parse(profileRaw) as ScrapedChannelProfile;
    return {
      jobId,
      kind: KIND,
      owner: OWNER,
      name: item.name?.S ?? profile.channelName ?? "YouTube channel",
      channelInput: item.channelInput?.S ?? profile.channelInput ?? "",
      profile,
      createdAt: Number(item.createdAt?.N ?? 0),
      updatedAt: Number(item.updatedAt?.N ?? 0),
    };
  } catch {
    return null;
  }
}

function summarizeRecords(records: ContentProfileRecord[]): ContentProfileSummary[] {
  return records
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((record) => ({
      id: record.jobId,
      name: record.name,
      channelInput: record.channelInput,
      channelUrl: record.profile?.channelUrl,
      videoCount: Array.isArray(record.profile?.recentVideos) ? record.profile.recentVideos.length : 0,
      scrapedAt: record.profile?.scrapedAt ?? 0,
      updatedAt: record.updatedAt ?? 0,
    }));
}

function mergeRecords(primary: ContentProfileRecord[], fallback: ContentProfileRecord[]): ContentProfileRecord[] {
  const byId = new Map<string, ContentProfileRecord>();
  for (const record of fallback) byId.set(record.jobId, record);
  for (const record of primary) byId.set(record.jobId, record);
  return [...byId.values()];
}

function resolveFilePath(filename: string): string {
  const root = process.env.REPL_HOME ?? process.cwd();
  const candidates = [
    process.env.CONTENT_PROFILE_FILE,
    join(root, filename),
    join(root, "artifacts", "api-server", filename),
    join(root, "..", filename),
    join(root, "..", "..", filename),
  ].filter((path): path is string => Boolean(path && path.trim()));
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

function loadFileRecords(): ContentProfileRecord[] {
  const storePath = resolveFilePath("saved-channel-profiles.json");
  if (!existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed as ContentProfileRecord[] : [];
  } catch {
    return [];
  }
}

function saveFileRecords(records: ContentProfileRecord[]): void {
  const target = resolveFilePath("saved-channel-profiles.json");
  writeFileSync(target, JSON.stringify(records, null, 2), "utf8");
}

function upsertFileRecord(record: ContentProfileRecord): void {
  const records = loadFileRecords();
  const existingIndex = records.findIndex((item) => item.jobId === record.jobId);
  if (existingIndex >= 0) {
    records[existingIndex] = record;
  } else {
    records.unshift(record);
  }
  saveFileRecords(records);
}
