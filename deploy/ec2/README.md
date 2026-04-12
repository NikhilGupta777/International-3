# EC2 Production Deployment (Recommended Path)

This setup deploys the app on one Ubuntu EC2 host using Docker Compose:

- `app`: Node API + static frontend
- `db`: PostgreSQL
- `bgutil-provider`: dynamic YouTube PO-token provider
- `proxy`: Caddy reverse proxy with automatic HTTPS

## 1) Provision an instance

From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\provision-instance.ps1 `
  -Region us-east-1 `
  -ProjectName ytgrabber-prod `
  -InstanceType c6a.xlarge `
  -VolumeSizeGiB 80 `
  -KeyName ytgrabber-prod-key
```

What this does:

- Creates/uses default VPC + subnet
- Creates security group (`22`, `80`, `443`)
- Creates key pair (saved to `deploy/ec2/keys/<key>.pem`)
- Launches Ubuntu 24.04 instance
- Installs Docker + Compose via user-data

## 2) Create production env file

Copy and fill:

```powershell
Copy-Item .\deploy\ec2\.env.production.example .\deploy\ec2\.env.production
```

Required values:

- `APP_DOMAIN` (must point DNS A record to EC2 public IP)
- `APP_EMAIL`
- `SESSION_SECRET`
- `GEMINI_API_KEY` (and optional fallback keys)
- `ASSEMBLYAI_API_KEY`
- `S3_BUCKET`, `S3_REGION`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (for closed-tab browser push alerts)

## 3) Deploy app over SSH

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\deploy-over-ssh.ps1 `
  -Host <EC2_PUBLIC_IP_OR_DOMAIN> `
  -KeyPath .\deploy\ec2\keys\ytgrabber-prod-key.pem `
  -LocalEnvPath .\deploy\ec2\.env.production `
  -Branch main
```

## 4) Validate

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\smoke-test.ps1 -BaseUrl https://<your-domain>
```

## 5) Monitoring Endpoints

- `GET /api/ops/metrics` returns runtime CPU/memory/disk usage, HTTP stats, and queue depth.
- `GET /api/ops/alerts` returns warning/critical signals (5xx rate, memory, disk, queue pressure).

## Operational notes

- App and clip outputs are temporary; S3 stores downloadable outputs with signed URLs.
- Caddy handles TLS cert provisioning automatically when DNS is set correctly.
- If DNS is not pointed yet, deploy still starts; TLS will become active once DNS resolves.
- To view logs:

```bash
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml logs -f app
```

## Rollback

```bash
cd /opt/ytgrabber
git log --oneline -n 5
git checkout <previous_commit>
sudo docker compose -f docker-compose.yml -f deploy/ec2/docker-compose.prod.yml up -d --build
```
