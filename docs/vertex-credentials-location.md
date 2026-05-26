# Vertex / Gemini Credentials Location

This document intentionally does not contain raw API keys or service-account private keys.
Do not paste Vertex service-account JSON or Gemini API keys into docs, chat, screenshots, or commits.

## Live AWS Configuration

Production Lambda:

- Function: `ytgrabber-green-api`
- Vertex enabled env: `GOOGLE_GENAI_USE_VERTEXAI=true`
- Vertex project env: `GOOGLE_CLOUD_PROJECT=gen-lang-client-0085137533`
- Vertex location env: `GOOGLE_CLOUD_LOCATION=global`
- S3 bucket env: `S3_BUCKET=malikaeditorr`
- S3 region env: `S3_REGION=us-east-1`
- S3 object prefix env: `S3_OBJECT_PREFIX=ytgrabber-green`

Vertex service-account credentials are stored here:

- S3 object: `s3://malikaeditorr/ytgrabber-green/secrets/vertex/service-account.json`
- Server-side encryption: `AES256`
- Current object size: `2384` bytes
- Last verified: `2026-05-18 19:36:24 UTC`

The Lambda stores the object key in:

- `GOOGLE_APPLICATION_CREDENTIALS_S3_KEY=ytgrabber-green/secrets/vertex/service-account.json`

## GitHub Secrets Used During Deploy

The deploy workflow reads these GitHub Actions secrets:

- `GOOGLE_GENAI_USE_VERTEXAI`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION`
- `GOOGLE_APPLICATION_CREDENTIALS_BASE64`
- `GEMINI_API_KEY`
- `GEMINI_API_KEY_2`
- `GEMINI_API_KEY_3`

Deploy behavior:

- If `GOOGLE_GENAI_USE_VERTEXAI` is true, the workflow decodes `GOOGLE_APPLICATION_CREDENTIALS_BASE64`.
- It uploads the decoded service-account JSON to S3 at the object path above.
- It stores only `GOOGLE_APPLICATION_CREDENTIALS_S3_KEY` in runtime env.
- `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, and `GEMINI_API_KEY_3` are still present as fallback direct Gemini keys.

## Safe Retrieval Commands

Use this only when you need to inspect or rotate the credential locally.
Do not commit the downloaded file.

```powershell
New-Item -ItemType Directory -Force -Path .local-secrets | Out-Null
aws s3 cp "s3://malikaeditorr/ytgrabber-green/secrets/vertex/service-account.json" ".local-secrets/vertex-service-account.json" --region us-east-1
```

To verify the file without printing secrets:

```powershell
Get-Item .local-secrets/vertex-service-account.json | Select-Object FullName,Length,LastWriteTime
```

To delete the local copy after use:

```powershell
Remove-Item -LiteralPath .local-secrets/vertex-service-account.json -Force
```

## Safe Rotation Process

1. Create or download the new Google service-account JSON from Google Cloud IAM.
2. Base64 encode it locally.
3. Update GitHub secret `GOOGLE_APPLICATION_CREDENTIALS_BASE64` with the new base64 value.
4. Run the production deploy workflow.
5. Confirm the S3 object metadata updates.
6. Confirm Lambda env still has `GOOGLE_GENAI_USE_VERTEXAI=true` and the same S3 key.
7. Revoke/delete the old Google service-account key in Google Cloud.

## Verification Commands Without Secret Exposure

```powershell
aws lambda get-function-configuration --function-name ytgrabber-green-api `
  --query "Environment.Variables.{vertex:GOOGLE_GENAI_USE_VERTEXAI,project:GOOGLE_CLOUD_PROJECT,location:GOOGLE_CLOUD_LOCATION,credsKey:GOOGLE_APPLICATION_CREDENTIALS_S3_KEY,bucket:S3_BUCKET,region:S3_REGION}" `
  --output json

aws s3api head-object `
  --bucket malikaeditorr `
  --key ytgrabber-green/secrets/vertex/service-account.json `
  --region us-east-1 `
  --query "{ContentLength:ContentLength,ServerSideEncryption:ServerSideEncryption,LastModified:LastModified}" `
  --output json
```
