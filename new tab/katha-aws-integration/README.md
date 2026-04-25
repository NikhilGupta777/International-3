# Katha Scene Find — AWS native integration bundle

This bundle moves the Lovable prototype into your existing `videomaking.in` stack as a native React feature, not an iframe.

## What is included

```txt
frontend/src/features/katha/KathaSceneFind.tsx   React tab/page UI
frontend/src/lib/katha-api.ts                    Browser API client
frontend/src/lib/image-utils.ts                  Image compression helpers
backend/src/katha/routes.ts                      Express routes mounted at /api/katha
backend/src/katha/identify.ts                    Gemini shortlist + final ranking pipeline
backend/src/katha/gemini.ts                      Gemini API caller
backend/src/katha/aws.ts                         S3 + DynamoDB helpers
backend/src/katha/prompts.ts                     Matching prompt + tool schemas
backend/src/katha/types.ts                       Shared backend types
infra/iam-policy-katha.json                      IAM permissions snippet
```

## Frontend install

Copy these files into your existing React/Vite app:

```txt
frontend/src/features/katha/KathaSceneFind.tsx -> src/features/katha/KathaSceneFind.tsx
frontend/src/lib/katha-api.ts -> src/lib/katha-api.ts
frontend/src/lib/image-utils.ts -> src/lib/image-utils.ts
```

Add the tab/page wherever your current app defines tabs:

```tsx
import KathaSceneFind from "./features/katha/KathaSceneFind";

// Example tab render
{activeTab === "katha-scene-find" && <KathaSceneFind />}
```

The UI calls same-origin relative URLs like `/api/katha/references`, so CloudFront should route `/api/*` to API Gateway/Lambda.

## Backend install

Copy `backend/src/katha/*` into your Lambda Express API repo.

Install AWS SDK packages:

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

Mount the router:

```ts
import { kathaRouter } from "./katha/routes";
app.use("/api/katha", kathaRouter);
```

## Required API routes

```txt
GET    /api/katha/references
POST   /api/katha/references
PATCH  /api/katha/references/place
DELETE /api/katha/references/:id
DELETE /api/katha/references/place/:placeName
POST   /api/katha/upload-url
POST   /api/katha/identify
```

## Environment variables

```txt
AWS_REGION=ap-south-1
S3_BUCKET=malikaeditorr
DYNAMODB_TABLE=ytgrabber-green-jobs
GEMINI_API_KEY=stored_secret
KATHA_REF_PREFIX=katha/references/
KATHA_QUERY_PREFIX=katha/query/
KATHA_PUBLIC_BASE_URL=https://videomaking.in/media
GEMINI_MODEL=gemini-1.5-flash
```

## DynamoDB storage model

The code stores references in your existing table with prefixed keys:

```json
{
  "pk": "KATHA_REF#uuid",
  "sk": "META",
  "type": "katha_reference",
  "id": "uuid",
  "place_name": "Venue name",
  "location": "City / date",
  "notes": "Backdrop notes",
  "s3_key": "katha/references/uuid.jpg",
  "image_url": "https://videomaking.in/media/katha/references/uuid.jpg",
  "created_at": "2026-04-24T00:00:00.000Z"
}
```

If your table does not use `pk` + `sk`, adjust the `Key` values in `backend/src/katha/aws.ts` to your table's real partition/sort key names.

## S3 layout

```txt
s3://malikaeditorr/katha/references/{uuid}.jpg
s3://malikaeditorr/katha/query/{uuid}.jpg
```

Browser uploads use pre-signed PUT URLs returned by Lambda.

## Important production notes

1. If S3 objects are not publicly served via CloudFront, change `publicUrlForKey()` to return signed read URLs or serve images through your media endpoint.
2. If reference count grows above a few hundred, move `/api/katha/identify` to an async Batch/Fargate job and poll status from DynamoDB.
3. Put `GEMINI_API_KEY` in your existing secret system or Lambda encrypted env vars, never in frontend code.
4. Add auth checks to the Express routes if this tab should only be available to admins/users.
5. Make sure S3 CORS allows `PUT` from `https://videomaking.in`.

## S3 CORS example

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedOrigins": ["https://videomaking.in"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```
