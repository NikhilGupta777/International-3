import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";

const REGION = process.env.S3_REGION || "us-east-1";
const TABLE_NAME = process.env.COOLDOWNS_TABLE || "ytgrabber-green-cooldowns";

// Gracefully handle DynamoDB when no credentials or config is set
const ddb = TABLE_NAME ? new DynamoDBClient({ region: REGION }) : null;

// Hashed API Key -> Expiration epoch timestamp (ms)
const localCooldownCache = new Map<string, number>();

/** Helper to generate SHA-256 hash of API key */
function hashKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey.trim()).digest("hex");
}

/** Check if key is currently in cooldown */
export function isKeyCooledDown(apiKey: string): boolean {
  const hash = hashKey(apiKey);
  const expiresAt = localCooldownCache.get(hash);
  if (!expiresAt) return false;
  
  if (Date.now() > expiresAt) {
    localCooldownCache.delete(hash); // Expired locally
    return false;
  }
  return true;
}

/** Get next available healthy key using round-robin index */
export function getNextAvailableKey(keys: string[], currentIndex: number): { key: string; index: number } {
  if (keys.length === 0) return { key: "", index: currentIndex };

  for (let i = 0; i < keys.length; i++) {
    const candidateIdx = (currentIndex + i) % keys.length;
    const candidateKey = keys[candidateIdx];
    
    if (!isKeyCooledDown(candidateKey)) {
      return { key: candidateKey, index: (candidateIdx + 1) % keys.length };
    }
  }

  // All keys are cooled down! Fallback to round-robin default rather than blocking entirely
  const defaultIdx = currentIndex % keys.length;
  return { key: keys[defaultIdx], index: (defaultIdx + 1) % keys.length };
}

/** Classify error and record key failure both locally and in DynamoDB */
export async function recordKeyFailure(apiKey: string, error: any): Promise<void> {
  const hash = hashKey(apiKey);
  const errMsg = String(error?.message ?? error ?? "").toLowerCase();
  const status = Number(error?.status ?? error?.code ?? 0);

  let cooldownMs = 0;
  let reason = "unknown";

  if (status === 429 || /rate.?limit|429/i.test(errMsg)) {
    if (/quota.*exceeded|daily|limit.*day|rpd/i.test(errMsg)) {
      cooldownMs = 24 * 60 * 60 * 1000; // 24 Hours (RPD)
      reason = "RPD Quota Limit";
    } else {
      cooldownMs = 60 * 1000; // 60 Seconds (RPM / TPM)
      reason = "RPM/TPM Rate Limit";
    }
  } else if (status === 503 || status === 504 || /unavailable|overloaded|timeout|deadline/i.test(errMsg)) {
    cooldownMs = 30 * 1000; // 30 Seconds
    reason = "Transient Service Overload";
  } else if (status === 401 || status === 403 || /api_key_invalid|auth/i.test(errMsg)) {
    cooldownMs = 24 * 60 * 60 * 1000; // 24 Hours
    reason = "Invalid Authentication Key";
  }

  if (cooldownMs === 0) return; // Do not cool down on user/request errors (400/404)

  const expiresAtMs = Date.now() + cooldownMs;
  localCooldownCache.set(hash, expiresAtMs);

  console.warn(`[Circuit Breaker] Flagged key ...${apiKey.slice(-6)} on cooldown for ${cooldownMs / 1000}s. Reason: ${reason}`);

  if (!ddb) return;

  // Write asynchronously to DynamoDB (TTL in epoch seconds)
  const expiresAtSeconds = Math.floor(expiresAtMs / 1000);
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: { S: `cooldown#${hash}` },
          reason: { S: reason },
          expiresAt: { N: String(expiresAtSeconds) },
        },
      })
    );
  } catch (ddbErr) {
    console.error("[Circuit Breaker] Failed to sync cooldown to DynamoDB:", ddbErr);
  }
}

/** Background synchronization loop to poll active cooldowns from DynamoDB */
export function startCooldownSyncLoop(): void {
  if (!ddb) {
    console.warn("[Circuit Breaker] DynamoDB is not configured. Cooldowns will operate in local memory mode only.");
    return;
  }

  const sync = async () => {
    try {
      const nowMs = Date.now();
      const currentHashes = new Set<string>();
      let lastEvaluatedKey: Record<string, any> | undefined;

      do {
        const out = await ddb.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            ExclusiveStartKey: lastEvaluatedKey,
          })
        );

        (out.Items || []).forEach((item) => {
          const pk = item.pk?.S || "";
          const expiresAtSec = Number(item.expiresAt?.N || 0);
          if (pk.startsWith("cooldown#") && expiresAtSec) {
            const hash = pk.replace("cooldown#", "");
            const expiresAtMs = expiresAtSec * 1000;

            if (expiresAtMs > nowMs) {
              localCooldownCache.set(hash, expiresAtMs);
              currentHashes.add(hash);
            }
          }
        });

        lastEvaluatedKey = out.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      // Clear local keys that have expired in DB
      for (const [hash] of localCooldownCache.entries()) {
        if (!currentHashes.has(hash)) {
          localCooldownCache.delete(hash);
        }
      }
    } catch (err) {
      console.warn("[Circuit Breaker] Background sync failed:", err);
    }
  };

  // Run initially and then every 30 seconds
  sync();
  setInterval(sync, 30 * 1000).unref();
}
