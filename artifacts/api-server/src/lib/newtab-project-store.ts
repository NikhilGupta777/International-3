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
import type {
  NewTabProject,
  ProjectActivityEntry,
  ProjectClip,
} from "./newtab-project-types";

/**
 * Storage for New Tab Studio projects.
 *
 * Follows the content-profile store pattern: one DynamoDB item per project with
 * the document serialized into an attribute, plus a local JSON file fallback so
 * the feature works in dev without AWS credentials. Project docs are small (clip
 * metadata only) — the actual media lives in S3 under the existing job namespaces.
 */

const KIND = "newtab-project";
const ID_PREFIX = "ntp_";
export const PROJECT_ID_RE = /^ntp_[a-f0-9]{32}$/;

function envTrim(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

const TABLE_NAME =
  envTrim("NEWTAB_PROJECT_TABLE") ||
  envTrim("YOUTUBE_QUEUE_JOB_TABLE") ||
  "ytgrabber-green-jobs";

const REGION =
  envTrim("NEWTAB_PROJECT_DDB_REGION") ||
  envTrim("YOUTUBE_QUEUE_REGION") ||
  envTrim("AWS_DEFAULT_REGION") ||
  envTrim("AWS_REGION") ||
  "us-east-1";

const MAX_ACTIVITY_ENTRIES = 300;

let dynamo: DynamoDBClient | null = null;

function client(): DynamoDBClient {
  dynamo ??= new DynamoDBClient({ region: REGION });
  return dynamo;
}

export function newProjectId(): string {
  return `${ID_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
}

export function newClipId(): string {
  return `clip_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function getProject(projectId: string, owner: string): Promise<NewTabProject | null> {
  if (!PROJECT_ID_RE.test(projectId)) return null;

  let record: NewTabProject | null = null;
  try {
    const out = await client().send(new GetItemCommand({
      TableName: TABLE_NAME,
      ConsistentRead: true,
      Key: { jobId: { S: projectId } },
    }));
    record = out.Item ? decodeRecord(out.Item) : null;
  } catch {
    record = null;
  }
  record ??= loadFileRecords().find((item) => item.projectId === projectId) ?? null;

  // Owner isolation: a project is only visible to the identity that created it.
  if (!record || record.owner !== owner) return null;
  return record;
}

export async function listProjects(owner: string): Promise<NewTabProject[]> {
  let records: NewTabProject[] = [];
  try {
    const items: Record<string, AttributeValue>[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const out = await client().send(new ScanCommand({
        TableName: TABLE_NAME,
        ConsistentRead: true,
        ExclusiveStartKey,
        FilterExpression: "#kind = :kind AND #owner = :owner",
        ExpressionAttributeNames: { "#kind": "kind", "#owner": "owner" },
        ExpressionAttributeValues: { ":kind": { S: KIND }, ":owner": { S: owner } },
      }));
      items.push(...(out.Items ?? []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    records = items
      .map(decodeRecord)
      .filter((item): item is NewTabProject => Boolean(item));
  } catch {
    records = [];
  }

  const merged = new Map<string, NewTabProject>();
  for (const record of loadFileRecords()) {
    if (record.owner === owner) merged.set(record.projectId, record);
  }
  for (const record of records) merged.set(record.projectId, record);

  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Write ──────────────────────────────────────────────────────────────────────

export async function saveProject(project: NewTabProject): Promise<NewTabProject> {
  const next: NewTabProject = {
    ...project,
    updatedAt: Date.now(),
    activity: (project.activity ?? []).slice(-MAX_ACTIVITY_ENTRIES),
  };
  let dynamoErr: unknown = null;
  try {
    await client().send(new PutItemCommand({ TableName: TABLE_NAME, Item: encodeRecord(next) }));
  } catch (err) {
    // DynamoDB unavailable (local dev) — the file fallback below is the store.
    dynamoErr = err;
  }
  const savedToFile = upsertFileRecord(next);
  // In Lambda the file write always fails (read-only FS), so a DynamoDB failure
  // there means nothing was persisted at all. Reporting success would hand the
  // caller a project that quietly does not exist.
  if (dynamoErr && !savedToFile) {
    throw new Error(
      `Could not save New Tab project ${next.projectId}: ${
        dynamoErr instanceof Error ? dynamoErr.message : String(dynamoErr)
      }`,
    );
  }
  return next;
}

/**
 * Read-modify-write helper. Phase 1 is single-writer (the API); the runner in
 * phase 2 will need a conditional write on updatedAt to avoid clobbering.
 */
export async function patchProject(
  projectId: string,
  owner: string,
  mutate: (project: NewTabProject) => NewTabProject | void,
): Promise<NewTabProject | null> {
  const existing = await getProject(projectId, owner);
  if (!existing) return null;
  const draft: NewTabProject = JSON.parse(JSON.stringify(existing));
  const result = mutate(draft) ?? draft;
  return saveProject(result);
}

export async function deleteProject(projectId: string, owner: string): Promise<boolean> {
  const existing = await getProject(projectId, owner);
  if (!existing) return false;
  try {
    await client().send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: projectId } },
    }));
  } catch {
    // fall through to the file store
  }
  const records = loadFileRecords();
  const filtered = records.filter((item) => item.projectId !== projectId);
  if (filtered.length !== records.length) saveFileRecords(filtered);
  return true;
}

// ── Mutation helpers ───────────────────────────────────────────────────────────

export function appendActivity(
  project: NewTabProject,
  entry: Omit<ProjectActivityEntry, "at"> & { at?: number },
): void {
  project.activity = [
    ...(project.activity ?? []),
    { at: entry.at ?? Date.now(), stage: entry.stage, level: entry.level, message: entry.message },
  ].slice(-MAX_ACTIVITY_ENTRIES);
}

export function updateClip(
  project: NewTabProject,
  clipId: string,
  patch: Partial<ProjectClip>,
): ProjectClip | null {
  const index = (project.clips ?? []).findIndex((clip) => clip.clipId === clipId);
  if (index < 0) return null;
  const next: ProjectClip = { ...project.clips[index]!, ...patch, updatedAt: Date.now() };
  project.clips[index] = next;
  return next;
}

// ── DynamoDB encoding ──────────────────────────────────────────────────────────

function encodeRecord(project: NewTabProject): Record<string, AttributeValue> {
  return {
    jobId: { S: project.projectId },
    kind: { S: KIND },
    owner: { S: project.owner },
    title: { S: project.title || "Untitled project" },
    lifecycle: { S: project.lifecycle },
    doc: { S: JSON.stringify(project) },
    createdAt: { N: String(project.createdAt) },
    updatedAt: { N: String(project.updatedAt) },
  };
}

function decodeRecord(item: Record<string, AttributeValue>): NewTabProject | null {
  const raw = item.doc?.S;
  if (!raw || item.kind?.S !== KIND) return null;
  try {
    const parsed = JSON.parse(raw) as NewTabProject;
    if (!parsed?.projectId) return null;
    return normalizeProject(parsed);
  } catch {
    return null;
  }
}

/** Defensive: older/partial docs must not crash the list endpoint. */
function normalizeProject(project: NewTabProject): NewTabProject {
  return {
    ...project,
    sourceVideos: Array.isArray(project.sourceVideos) ? project.sourceVideos : [],
    clips: Array.isArray(project.clips) ? project.clips : [],
    activity: Array.isArray(project.activity) ? project.activity : [],
  };
}

// ── File fallback ──────────────────────────────────────────────────────────────

function resolveFilePath(): string {
  const root = process.env.REPL_HOME ?? process.cwd();
  const candidates = [
    envTrim("NEWTAB_PROJECT_FILE"),
    join(root, "newtab-projects.json"),
    join(root, "artifacts", "api-server", "newtab-projects.json"),
  ].filter((path) => Boolean(path && path.trim()));
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

function loadFileRecords(): NewTabProject[] {
  const storePath = resolveFilePath();
  if (!existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? (parsed as NewTabProject[]).map(normalizeProject) : [];
  } catch {
    return [];
  }
}

function saveFileRecords(records: NewTabProject[]): boolean {
  try {
    writeFileSync(resolveFilePath(), JSON.stringify(records, null, 2), "utf8");
    return true;
  } catch {
    // Read-only filesystem (Lambda) — DynamoDB is the real store there.
    return false;
  }
}

function upsertFileRecord(project: NewTabProject): boolean {
  const records = loadFileRecords();
  const index = records.findIndex((item) => item.projectId === project.projectId);
  if (index >= 0) records[index] = project;
  else records.unshift(project);
  return saveFileRecords(records);
}
