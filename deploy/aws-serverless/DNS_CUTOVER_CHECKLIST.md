# DNS Cutover Checklist (`videomaking.in` -> Serverless CloudFront)

Current serverless target:

- CloudFront domain: `d2bcwj2idfdwb4.cloudfront.net`
- CloudFront distribution id: `EDTEON6GFBEZH`

Current blocker:

- Public domain still resolves to EC2 (`3.238.114.190`), so 24/7 EC2 billing continues.

## 1) ACM certificate requested (us-east-1)

- Certificate ARN: `arn:aws:acm:us-east-1:596596146505:certificate/62ff8b55-8a4b-4634-97e8-75924181c9f5`

DNS validation CNAMEs to add in the DNS provider:

1. `Name`: `_1f22665c298ecd09748a05def5550c75.videomaking.in`
   - `Type`: `CNAME`
   - `Value`: `_43bc9247aa50c1d1b23c0801dad62ebf.jkddzztszm.acm-validations.aws`
2. `Name`: `_b53f775d27fba2f8ccbbeef12047fb6c.www.videomaking.in`
   - `Type`: `CNAME`
   - `Value`: `_c01e8ede080a84e6903eb288bffcb4e8.jkddzztszm.acm-validations.aws`

## 2) After cert is `ISSUED`, update serverless stack

Run:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\aws-serverless\deploy-serverless.ps1 `
  -EnvFilePath scratch\.env.green.deploytmp `
  -Prefix ytgrabber-green `
  -Region us-east-1 `
  -SiteDomainName www.videomaking.in `
  -CloudFrontCertificateArn arn:aws:acm:us-east-1:596596146505:certificate/62ff8b55-8a4b-4634-97e8-75924181c9f5
```

## 3) DNS records for traffic cutover

Recommended with DNS providers that do not support apex ALIAS to CloudFront:

1. Set `www` as CNAME to `d2bcwj2idfdwb4.cloudfront.net`
2. Set apex `@` HTTP redirect to `https://www.videomaking.in`
3. Remove old apex A record to EC2 (`3.238.114.190`) after validation

## 4) Post-cutover verification

1. `https://www.videomaking.in/api/healthz` returns 200 with CloudFront headers.
2. Auth login works.
3. `clip-cut`, `best-clips`, and `subtitles` each reach terminal status (`done` or clear `error`) via worker queue.
4. `https://www.videomaking.in/api/youtube/progress/not-a-real-job` returns JSON (not HTML fallback).
5. EC2 runtime services can be stopped/decommissioned.

