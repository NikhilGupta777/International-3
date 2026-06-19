import { createApiKey } from "./src/lib/api-key-auth";

async function main() {
  const result = await createApiKey({
    name: "CLI Test Key",
    ownerEmail: "test@example.com",
    scopes: ["*"],
    createdBy: "system",
  });
  console.log(result.rawKey);
}

main().catch(console.error);
