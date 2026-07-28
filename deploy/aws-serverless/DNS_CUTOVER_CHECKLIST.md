# DNS Cutover Checklist (`videomaking.in` -> CloudFront)

This file describes the post-cutover production state. Follow the complete migration,
cutover, and rollback record in
[`../../AWS-MASTER-SETUP-AND-MIGRATION.md`](../../AWS-MASTER-SETUP-AND-MIGRATION.md).

## Current verified state (2026-07-28 IST)

- AWS account: `386318011485`, region `us-east-1`.
- CloudFront: `E36OKTEHMEZQ4N` / `dq163fbjr1do7.cloudfront.net`, deployed.
- Aliases: `videomaking.in`, `www.videomaking.in`.
- Hostinger DNS: apex `ALIAS @` and `CNAME www` point to
  `dq163fbjr1do7.cloudfront.net` with TTL 300.
- Authoritative DNS: `ns1.dns-parking.com`, `ns2.dns-parking.com` (external to Route 53).
- ACM certificate: `d849e124-73a0-41bd-ae85-2a378a51ba43`, `ISSUED`, in use,
  `us-east-1`, SANs for apex + `www`.
- TLS: `TLSv1.2_2021`, SNI.
- API origin: Lambda Function URL; static origin: private S3 through OAC.
- Apex, `www`, and `/api/healthz` return HTTP 200.

The old distribution `EDTEON6GFBEZH` / `d2bcwj2idfdwb4.cloudfront.net` is enabled but
owns no production aliases. It is a rollback target only.

## Active certificate validation records

Retain both records for ACM renewal:

1. `_66f1c649ca9d94398ac8f8fe70dcb953.videomaking.in` CNAME
   `_83d2718c0ff3da0b0d8a112d4e56189b.jkddzztszm.acm-validations.aws`
2. `_7852a1d6163e9c05f74b482154a97f6f.www.videomaking.in` CNAME
   `_935a7b2156447f676c681f194c527035.jkddzztszm.acm-validations.aws`

Do not replace these with the old certificate's validation records.

## Completed cutover summary

1. Target ACM validation completed and the certificate became `ISSUED`.
2. Hostinger apex/`www` records moved to the new CloudFront distribution.
3. The old distribution released both aliases; the new distribution attached them.
4. Production TLS, HTTP, health, auth, Lambda, normal Fargate, and allowed feature
   checks passed. GPU/Translator, HeyGen, Pita Ji, and Workspace/Drive were excluded.
5. The old distribution remains intact for rollback. Historical job migration is not
   required by owner decision.

## Rollback

Rollback requires an explicitly coordinated alias move: release apex/`www` from
`E36OKTEHMEZQ4N`, restore them and the old certificate on `EDTEON6GFBEZH`, then point
Hostinger apex/`www` to `d2bcwj2idfdwb4.cloudfront.net`. Cross-account CloudFront
aliases cannot be attached to both distributions simultaneously, so plan a short outage
window. Do not perform rollback or delete either distribution without owner approval.
