# Backend integration

Install packages in your existing Lambda Express API repo:

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

Copy `src/katha/*` into your API repo, then mount the router:

```ts
import { kathaRouter } from "./katha/routes";

app.use("/api/katha", kathaRouter);
```

Required Lambda environment variables:

```txt
AWS_REGION=ap-south-1
S3_BUCKET=malikaeditorr
DYNAMODB_TABLE=ytgrabber-green-jobs
GEMINI_API_KEY=your_secret_key
KATHA_REF_PREFIX=katha/references/
KATHA_QUERY_PREFIX=katha/query/
KATHA_PUBLIC_BASE_URL=https://videomaking.in/media
GEMINI_MODEL=gemini-1.5-flash
```

If your S3 images are not public through CloudFront, set `KATHA_PUBLIC_BASE_URL` to the CloudFront origin path that serves `malikaeditorr` objects, or modify `publicUrlForKey()` to return signed read URLs.

Suggested Lambda settings:

```txt
Timeout: 120-300 seconds
Memory: 1024-2048 MB
Ephemeral storage: 1024 MB
```
