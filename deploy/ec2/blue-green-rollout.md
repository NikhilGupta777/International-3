# Blue-Green Rollout (Keep Current Production Live)

This flow keeps `videomaking.in` serving users while a separate green environment is built and tested.

## 1) Provision green instance

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\provision-green.ps1
```

Default config for green:

- Project: `ytgrabber-green`
- Key name: `ytgrabber-green-key`
- Instance type: `c6a.large`
- Disk: `40 GiB`

## 2) Prepare green env

```powershell
Copy-Item .\deploy\ec2\.env.green.example .\deploy\ec2\.env.green
```

Set these before deploy:

- `APP_DOMAIN=green.videomaking.in`
- `SESSION_SECRET`
- API keys
- S3 config (recommended separate prefix: `ytgrabber-green`)
- VAPID keys

## 3) Deploy green

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\deploy-green.ps1 -HostName <GREEN_IP_OR_DOMAIN> -Branch main
```

## 4) DNS for green

Create DNS A record:

- `green.videomaking.in` -> `<GREEN_PUBLIC_IP>`

Then run smoke test:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\smoke-test.ps1 -BaseUrl https://green.videomaking.in
```

## 5) Validate before cutover

Checklist:

- Health endpoint passes
- Download, Clip Cut, Best Clips, Subtitles pass
- Push notifications pass
- Queue/activity panels update correctly
- Logs show no sustained 5xx

## 6) Cutover to green

When green is fully validated, update DNS:

- `videomaking.in` A record -> `<GREEN_PUBLIC_IP>`
- `www` CNAME remains to apex (or update as needed)

Keep old production instance running for rollback until confidence window ends.

## 7) Rollback

If needed, switch DNS back to old production IP.

No code rollback required for immediate recovery.
