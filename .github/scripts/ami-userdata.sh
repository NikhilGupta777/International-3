#!/bin/bash
# AMI builder user-data script — runs on a temp EC2 instance to pre-pull the
# translator image so future Batch cold-starts take 2-4 min instead of 15-20 min.
# Tokens (ACCOUNT_PLACEHOLDER, REGION_PLACEHOLDER, TRANSLATOR_IMAGE_PLACEHOLDER)
# are substituted by CI via sed before base64-encoding.
set -Eeuo pipefail

# Tee all output to cloud-init log and the serial console for post-mortem debugging.
exec > >(tee /var/log/ami-userdata.log | logger -t ami-userdata -s 2>/dev/console) 2>&1

export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

ACCOUNT="ACCOUNT_PLACEHOLDER"
REGION="REGION_PLACEHOLDER"
IMAGE="TRANSLATOR_IMAGE_PLACEHOLDER"

log() { echo "[AMI] $*"; }

# ── IMDSv2-safe instance-id fetch ─────────────────────────────────────────────
metadata() {
  local token
  token="$(curl -fsS -m 5 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)"
  if [ -n "$token" ]; then
    curl -fsS -m 5 -H "X-aws-ec2-metadata-token: $token" \
      "http://169.254.169.254/latest/meta-data/$1"
  else
    # IMDSv1 fallback (should rarely be needed)
    curl -fsS -m 5 "http://169.254.169.254/latest/meta-data/$1"
  fi
}

INSTANCE_ID="$(metadata instance-id)"
log "Instance: $INSTANCE_ID  Image: $IMAGE"

tag_status() {
  aws ec2 create-tags \
    --region "$REGION" \
    --resources "$INSTANCE_ID" \
    --tags "Key=ami-build-status,Value=$1" || true
}

on_error() {
  local rc=$?
  log "FAILED (exit ${rc}) — tagging instance as failed"
  tag_status failed
  exit "$rc"
}
trap on_error ERR

# ── Guard: reject obviously invalid image URIs ────────────────────────────────
if [ -z "$IMAGE" ] || [ "$IMAGE" = "SKIP" ] || [[ "$IMAGE" == *":None" ]]; then
  log "ERROR: Invalid translator image URI: '$IMAGE'"
  exit 10
fi

# ── Ensure AWS CLI is present ─────────────────────────────────────────────────
if ! command -v aws >/dev/null 2>&1; then
  log "Installing aws-cli..."
  yum install -y aws-cli 2>/dev/null || true
fi

# ── Ensure Docker is running ──────────────────────────────────────────────────
log "Starting Docker..."
systemctl enable docker 2>/dev/null || true
systemctl start  docker 2>/dev/null || true
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
docker info >/dev/null  # hard fail if still not up

# ── ECR login — plain get-login-password, no credential helper needed ─────────
log "Authenticating to ECR..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

# ── Pull the translator image (the expensive 20 GB step) ─────────────────────
log "Pulling translator image (this takes 10-20 min)..."
docker pull "$IMAGE"

# ── Validate the image was actually stored locally ───────────────────────────
log "Verifying image..."
docker image inspect "$IMAGE" >/dev/null

# ── ECS agent config — idempotent writes ─────────────────────────────────────
log "Configuring ECS agent..."
mkdir -p /etc/ecs

upsert_ecs() {
  local key="$1" val="$2"
  if grep -q "^${key}=" /etc/ecs/ecs.config 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" /etc/ecs/ecs.config
  else
    echo "${key}=${val}" >> /etc/ecs/ecs.config
  fi
}

upsert_ecs ECS_IMAGE_PULL_BEHAVIOR         prefer-cached
upsert_ecs ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION 24h

# ── Flush writes before AMI snapshot ─────────────────────────────────────────
sync

# ── Signal success ────────────────────────────────────────────────────────────
tag_status ready
log "AMI builder completed successfully."
