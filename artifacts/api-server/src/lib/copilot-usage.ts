import {
  BatchGetItemCommand,
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  COPILOT_FALLBACK_MODELS,
  COPILOT_FAST_MODEL,
  COPILOT_ULTRA_MODEL,
} from "./copilot-external-provider";

const ddb = new DynamoDBClient({
  region: process.env.YOUTUBE_QUEUE_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
});

const tableName = () => process.env.AI_USAGE_TABLE?.trim() ?? "";
const n = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));
const dayKey = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

type CopilotUsageContext = {
  runId: string;
  sessionId: string;
  userId: string;
  mode: "ultra" | "fast";
};
const usageContext = new AsyncLocalStorage<CopilotUsageContext>();

export function enterCopilotUsageContext(context: CopilotUsageContext): void {
  usageContext.enterWith(context);
}

export async function recordCopilotHelperUsage(args: {
  provider: string;
  model: string;
  operation: string;
  startedAt: number;
  metadata: any;
}): Promise<void> {
  const context = usageContext.getStore();
  if (!context) return;
  await recordCopilotUsage({
    eventId: `${context.runId}:helper:${args.operation}:${randomUUID()}`,
    runId: context.runId,
    sessionId: context.sessionId,
    userId: context.userId,
    mode: context.mode,
    provider: args.provider,
    model: args.model,
    iteration: 0,
    fallback: false,
    durationMs: Date.now() - args.startedAt,
    usage: normalizeCopilotUsage(args.metadata),
  });
}

export type CopilotTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

export function normalizeCopilotUsage(metadata: any): CopilotTokenUsage | null {
  if (!metadata) return null;
  const inputTokens = n(metadata.promptTokenCount ?? metadata.input_tokens ?? metadata.prompt_tokens);
  const outputTokens = n(metadata.candidatesTokenCount ?? metadata.output_tokens ?? metadata.completion_tokens);
  const reasoningTokens = n(metadata.thoughtsTokenCount ?? metadata.reasoning_tokens);
  const cachedTokens = n(metadata.cachedContentTokenCount ?? metadata.cached_tokens);
  const totalTokens = n(metadata.totalTokenCount ?? metadata.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, reasoningTokens, cachedTokens, totalTokens };
}

export async function recordCopilotUsage(args: {
  eventId: string;
  timestamp?: number;
  runId: string;
  sessionId?: string;
  userId?: string;
  mode: "ultra" | "fast";
  provider: string;
  model: string;
  iteration: number;
  fallback: boolean;
  durationMs: number;
  usage: CopilotTokenUsage | null;
}): Promise<void> {
  const table = tableName();
  if (!table) return;
  const timestamp = args.timestamp ?? Date.now();
  const day = dayKey(timestamp);
  const usage = args.usage ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0 };
  const dimensions = ["TOTAL", `MODE#${args.mode}`, `MODEL#${args.model}`, `PROVIDER#${args.provider}`];
  try {
    await ddb.send(new TransactWriteItemsCommand({
      TransactItems: [
        { Put: { TableName: table, Item: {
        pk: { S: `EVENT#${day}` },
        sk: { S: `${timestamp}#${args.eventId}` },
        eventId: { S: args.eventId }, runId: { S: args.runId },
        sessionId: { S: args.sessionId || "unknown" }, userId: { S: args.userId || "unknown" },
        mode: { S: args.mode }, provider: { S: args.provider }, model: { S: args.model },
        iteration: { N: String(args.iteration) }, fallback: { BOOL: args.fallback },
        durationMs: { N: String(n(args.durationMs)) }, usageAvailable: { BOOL: Boolean(args.usage) },
        inputTokens: { N: String(usage.inputTokens) }, outputTokens: { N: String(usage.outputTokens) },
        reasoningTokens: { N: String(usage.reasoningTokens) }, cachedTokens: { N: String(usage.cachedTokens) },
        totalTokens: { N: String(usage.totalTokens) },
        expiresAt: { N: String(Math.floor(timestamp / 1000) + 90 * 24 * 60 * 60) },
        }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        ...dimensions.map((dimension) => ({ Update: {
          TableName: table,
          Key: { pk: { S: `ROLLUP#${day}` }, sk: { S: dimension } },
          UpdateExpression: "ADD calls :one, usageUnavailable :missing, inputTokens :input, outputTokens :output, reasoningTokens :reasoning, cachedTokens :cached, totalTokens :total SET updatedAt = :updated",
          ExpressionAttributeValues: {
            ":one": { N: "1" }, ":missing": { N: args.usage ? "0" : "1" },
            ":input": { N: String(usage.inputTokens) }, ":output": { N: String(usage.outputTokens) },
            ":reasoning": { N: String(usage.reasoningTokens) }, ":cached": { N: String(usage.cachedTokens) },
            ":total": { N: String(usage.totalTokens) }, ":updated": { N: String(timestamp) },
          },
        } })),
      ],
    }));
  } catch (error: any) {
    if (error?.name === "TransactionCanceledException") return;
    throw error;
  }
}

type UsageRollup = CopilotTokenUsage & { calls: number; usageUnavailable: number };
const emptyRollup = (): UsageRollup => ({ calls: 0, usageUnavailable: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0 });

export async function getCopilotUsageOverview(now = Date.now()) {
  const table = tableName();
  if (!table) return {
    enabled: false,
    today: emptyRollup(),
    month: emptyRollup(),
    todayByMode: { ultra: emptyRollup(), fast: emptyRollup() },
    todayByModel: {},
    last7Days: [],
  };
  const today = dayKey(now);
  const month = today.slice(0, 7);
  const days: string[] = [];
  for (let i = 0; i < 31; i++) {
    const date = dayKey(now - i * 86_400_000);
    if (!date.startsWith(month)) break;
    days.push(date);
  }
  const trackedModels = [...new Set([COPILOT_ULTRA_MODEL, COPILOT_FAST_MODEL, ...COPILOT_FALLBACK_MODELS])];
  const detailDimensions = [
    "MODE#ultra", "MODE#fast",
    ...trackedModels.map((model) => `MODEL#${model}`),
  ];
  const response = await ddb.send(new BatchGetItemCommand({
    RequestItems: { [table]: { Keys: [
      ...days.map((day) => ({ pk: { S: `ROLLUP#${day}` }, sk: { S: "TOTAL" } })),
      ...detailDimensions.map((dimension) => ({ pk: { S: `ROLLUP#${today}` }, sk: { S: dimension } })),
    ] } },
  }));
  const byDay = new Map<string, UsageRollup>();
  const details: Record<string, UsageRollup> = {};
  for (const item of response.Responses?.[table] ?? []) {
    const day = item.pk?.S?.replace("ROLLUP#", "") ?? "";
    const row = {
      calls: n(item.calls?.N), usageUnavailable: n(item.usageUnavailable?.N),
      inputTokens: n(item.inputTokens?.N), outputTokens: n(item.outputTokens?.N),
      reasoningTokens: n(item.reasoningTokens?.N), cachedTokens: n(item.cachedTokens?.N), totalTokens: n(item.totalTokens?.N),
    };
    if (item.sk?.S === "TOTAL") byDay.set(day, row);
    else if (day === today && item.sk?.S) details[item.sk.S] = row;
  }
  const monthTotal = days.reduce((sum, day) => {
    const row = byDay.get(day) ?? emptyRollup();
    for (const key of Object.keys(sum) as Array<keyof UsageRollup>) sum[key] += row[key];
    return sum;
  }, emptyRollup());
  return {
    enabled: true,
    today: byDay.get(today) ?? emptyRollup(),
    month: monthTotal,
    todayByMode: { ultra: details["MODE#ultra"] ?? emptyRollup(), fast: details["MODE#fast"] ?? emptyRollup() },
    todayByModel: Object.fromEntries(trackedModels.map((model) => [model, details[`MODEL#${model}`] ?? emptyRollup()])),
    last7Days: days.slice(0, 7).reverse().map((day) => ({ day, ...(byDay.get(day) ?? emptyRollup()) })),
  };
}
