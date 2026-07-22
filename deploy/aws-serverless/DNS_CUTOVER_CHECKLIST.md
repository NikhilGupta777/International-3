# DNS Cutover Checklist (`videomaking.in` -> CloudFront)

This file describes the current AWS account. For a new-account migration, do not reuse
the certificate ARN, distribution ID, or validation records below. Follow the complete
cutover and rollback process in
[`../../AWS-MASTER-SETUP-AND-MIGRATION.md`](../../AWS-MASTER-SETUP-AND-MIGRATION.md).

## Current verified state (2026-07-23)

- CloudFront: `EDTEON6GFBEZH` / `d2bcwj2idfdwb4.cloudfront.net`, deployed.
- Aliases: `videomaking.in`, `www.videomaking.in`.
- `www` CNAME: `d2bcwj2idfdwb4.cloudfront.net`.
- Authoritative DNS: `ns1.dns-parking.com`, `ns2.dns-parking.com` (external to Route 53).
- ACM certificate: issued, in use, `us-east-1`, SANs for apex + `www`.
- TLS: `TLSv1.2_2021`, SNI.
- API origin: Lambda Function URL; static origin: private S3 through OAC.

The old note that the public domain still points to EC2 is obsolete.

## Existing certificate records

These records belong to the current certificate only:

1. `_1f22665c298ecd09748a05def5550c75.videomaking.in` CNAME
   `_43bc9247aa50c1d1b23c0801dad62ebf.jkddzztszm.acm-validations.aws`
2. `_b53f775d27fba2f8ccbbeef12047fb6c.www.videomaking.in` CNAME
   `_c01e8ede080a84e6903eb288bffcb4e8.jkddzztszm.acm-validations.aws`

Do not remove them while the current certificate is needed for rollback or renewal.

## New-account cutover summary

1. Lower DNS TTL before the maintenance window.
2. Request a new ACM certificate in `us-east-1` for apex + `www`.
3. Add the new certificate's validation CNAMEs and wait for `ISSUED`.
4. Deploy and fully test the new CloudFront domain before changing traffic.
5. Pause writes and perform final S3/DynamoDB sync.
6. Update apex/`www` to the new CloudFront target.
7. Verify health, auth, Super Agent, Lambda clips, Fargate jobs, downloads, and alarms.
8. Keep the old distribution/certificate/DNS values for rollback until acceptance ends.

Never remove old DNS or AWS resources before the final data sync and rollback window.
