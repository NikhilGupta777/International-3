#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  unzip \
  docker.io \
  docker-compose-v2

systemctl enable docker
systemctl start docker

mkdir -p /opt/ytgrabber
chown -R ubuntu:ubuntu /opt/ytgrabber

# Keep host lean; cleanup apt cache.
apt-get clean
rm -rf /var/lib/apt/lists/*
