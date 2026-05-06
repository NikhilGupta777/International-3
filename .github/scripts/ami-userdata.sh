#!/bin/bash
# AMI builder user-data script — runs on a temp EC2 instance to pre-pull the
# translator image so future Batch cold-starts take 2-4 min instead of 15-20 min.
# Tokens (ACCOUNT_ID, AWS_REGION, IMAGE_URI) are substituted by CI via sed
# before this script is base64-encoded and passed as EC2 user-data.

export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -e

echo "[AMI] Installing ECR credential helper..."
yum install -y amazon-ecr-credential-helper 2>/dev/null || true

echo "[AMI] Configuring docker ECR helper..."
mkdir -p /root/.docker
printf '{"credHelpers":{"ACCOUNT_PLACEHOLDER.dkr.ecr.REGION_PLACEHOLDER.amazonaws.com":"ecr-login"}}' \
  > /root/.docker/config.json

echo "[AMI] Pulling translator image..."
docker pull TRANSLATOR_IMAGE_PLACEHOLDER
echo "[AMI] Pull complete."

echo "ECS_IMAGE_PULL_BEHAVIOR=prefer-cached"         >> /etc/ecs/ecs.config
echo "ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=24h"     >> /etc/ecs/ecs.config

# aws CLI needed to tag the instance; install as fallback in case it's missing.
yum install -y aws-cli 2>/dev/null || true

INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 create-tags \
  --region REGION_PLACEHOLDER \
  --resources "$INSTANCE_ID" \
  --tags Key=ami-build-status,Value=ready

echo "[AMI] Tagged as ready."
