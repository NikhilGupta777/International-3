#!/bin/bash
# AMI builder user-data script. Runs on a temp EC2 instance to pre-pull the
# translator image so future Batch cold-starts take 2-4 min instead of 15-20 min.
# Tokens (ACCOUNT_ID, AWS_REGION, IMAGE_URI) are substituted by CI via sed
# before this script is base64-encoded and passed as EC2 user-data.

export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -Eeuo pipefail

log() {
  echo "[AMI] $*"
}

metadata() {
  local path="$1"
  local token
  token="$(curl -fsS -m 2 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)"
  if [ -n "$token" ]; then
    curl -fsS -m 5 -H "X-aws-ec2-metadata-token: $token" \
      "http://169.254.169.254/latest/meta-data/${path}"
  else
    curl -fsS -m 5 "http://169.254.169.254/latest/meta-data/${path}"
  fi
}

INSTANCE_ID="$(metadata instance-id)"

tag_status() {
  aws ec2 create-tags \
    --region REGION_PLACEHOLDER \
    --resources "$INSTANCE_ID" \
    --tags Key=ami-build-status,Value="$1"
}

on_error() {
  local rc=$?
  log "FAILED with exit code ${rc}"
  tag_status failed || true
  exit "$rc"
}
trap on_error ERR

log "Installing AWS CLI and ECR credential helper..."
if ! command -v aws >/dev/null 2>&1; then
  yum install -y aws-cli
fi
yum install -y amazon-ecr-credential-helper || true

log "Configuring docker ECR helper..."
mkdir -p /root/.docker
printf '{"credHelpers":{"ACCOUNT_PLACEHOLDER.dkr.ecr.REGION_PLACEHOLDER.amazonaws.com":"ecr-login"}}' \
  > /root/.docker/config.json

log "Waiting for Docker daemon..."
systemctl start docker || true
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker info >/dev/null

log "Authenticating to ECR..."
aws ecr get-login-password --region REGION_PLACEHOLDER \
  | docker login --username AWS --password-stdin ACCOUNT_PLACEHOLDER.dkr.ecr.REGION_PLACEHOLDER.amazonaws.com

log "Pulling translator image: TRANSLATOR_IMAGE_PLACEHOLDER"
docker pull TRANSLATOR_IMAGE_PLACEHOLDER
docker image inspect TRANSLATOR_IMAGE_PLACEHOLDER >/dev/null
log "Pull complete."

grep -q '^ECS_IMAGE_PULL_BEHAVIOR=' /etc/ecs/ecs.config 2>/dev/null \
  && sed -i 's/^ECS_IMAGE_PULL_BEHAVIOR=.*/ECS_IMAGE_PULL_BEHAVIOR=prefer-cached/' /etc/ecs/ecs.config \
  || echo "ECS_IMAGE_PULL_BEHAVIOR=prefer-cached" >> /etc/ecs/ecs.config

grep -q '^ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=' /etc/ecs/ecs.config 2>/dev/null \
  && sed -i 's/^ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=.*/ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=24h/' /etc/ecs/ecs.config \
  || echo "ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=24h" >> /etc/ecs/ecs.config

docker images --digests | head -50

tag_status ready
log "Tagged as ready."
