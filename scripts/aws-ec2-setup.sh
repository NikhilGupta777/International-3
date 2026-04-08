#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# YTGrabber — AWS EC2 Setup Script
#
# Run this once on a fresh Ubuntu 24.04 EC2 instance to install Docker,
# clone the repo, and start the app via Docker Compose.
#
# Recommended instance type: t3.medium (2 vCPU, 4 GB RAM) or larger.
# Storage: at least 30 GB root volume (for Docker images + temp downloads).
#
# Usage:
#   REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO.git \
#     chmod +x scripts/aws-ec2-setup.sh && ./scripts/aws-ec2-setup.sh
#
# Required environment variables:
#   REPO_URL   — full git clone URL of this repository
#
# Optional environment variables:
#   APP_DIR    — install directory (default: /opt/ytgrabber)
#   APP_PORT   — port to expose (default: 8080)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Validate required inputs ──────────────────────────────────────────────────
if [ -z "${REPO_URL:-}" ] || [ "$REPO_URL" = "https://github.com/YOUR_USERNAME/YOUR_REPO.git" ]; then
  echo "ERROR: REPO_URL is not set or is still the placeholder."
  echo ""
  echo "  Run the script like this:"
  echo "  REPO_URL=https://github.com/your-org/your-repo.git ./scripts/aws-ec2-setup.sh"
  echo ""
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/ytgrabber}"
APP_PORT="${APP_PORT:-8080}"

echo "=== [1/7] Updating system packages ==="
sudo apt-get update -y
sudo apt-get upgrade -y

echo "=== [2/7] Installing Docker ==="
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow current user to run Docker without sudo
sudo usermod -aG docker "$USER"
echo "Docker installed. You may need to log out and back in for group changes."

echo "=== [3/7] Installing git ==="
sudo apt-get install -y git

echo "=== [4/7] Opening firewall port $APP_PORT ==="
# Allow the app port through ufw if it is active
if sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow "$APP_PORT"/tcp
  echo "ufw: opened port $APP_PORT."
else
  echo "ufw is not active — skipping local firewall rule."
fi
echo ""
echo "┌──────────────────────────────────────────────────────────────────────┐"
echo "│  ACTION REQUIRED — AWS Security Group                               │"
echo "│                                                                      │"
echo "│  Make sure your EC2 Security Group has an inbound rule:             │"
echo "│    Type: Custom TCP   Port: $APP_PORT   Source: 0.0.0.0/0           │"
echo "│                                                                      │"
echo "│  Without this the app will be unreachable from the internet.        │"
echo "└──────────────────────────────────────────────────────────────────────┘"
echo ""
read -r -p "Press ENTER once you have verified the Security Group rule ..."

echo "=== [5/7] Cloning repository ==="
if [ ! -d "$APP_DIR" ]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
  sudo chown -R "$USER":"$USER" "$APP_DIR"
else
  echo "Directory $APP_DIR already exists, pulling latest..."
  git -C "$APP_DIR" pull
fi

echo "=== [6/7] Configuring environment variables ==="
cd "$APP_DIR"

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "┌──────────────────────────────────────────────────────────────────┐"
  echo "│  IMPORTANT: Edit .env before starting the app!                   │"
  echo "│                                                                   │"
  echo "│  nano $APP_DIR/.env                                              │"
  echo "│                                                                   │"
  echo "│  Required values:                                                 │"
  echo "│   DATABASE_URL  — already set for docker-compose postgres         │"
  echo "│   GEMINI_API_KEY — your Google Gemini key                         │"
  echo "│   BHAGWAT_PASSWORD — password for the Bhagwat editor              │"
  echo "│                                                                   │"
  echo "│  ⚠️  CRITICAL — YouTube bot-detection on AWS IPs:                 │"
  echo "│   AWS EC2 IPs are blocked by YouTube. Set ONE of these:           │"
  echo "│                                                                   │"
  echo "│   YTDLP_COOKIES_BASE64 (EASIEST):                                 │"
  echo "│    1. Install 'Get cookies.txt LOCALLY' Chrome extension           │"
  echo "│    2. Log into YouTube in your browser                             │"
  echo "│    3. Click extension on youtube.com → export cookies.txt         │"
  echo "│    4. Run: base64 -w 0 cookies.txt                                │"
  echo "│    5. Paste the result in .env as YTDLP_COOKIES_BASE64=...        │"
  echo "│                                                                   │"
  echo "│   OR: set YTDLP_PO_TOKEN + YTDLP_VISITOR_DATA                    │"
  echo "│    Run: npx youtube-trusted-session-generator  (on any PC)        │"
  echo "│                                                                   │"
  echo "│   OR: set YTDLP_PROXY to a residential proxy URL                  │"
  echo "│                                                                   │"
  echo "│   After deploy, check: http://YOUR_IP:8080/api/youtube/diagnostics│"
  echo "└──────────────────────────────────────────────────────────────────┘"
  echo ""
  read -r -p "Press ENTER when you have finished editing .env ..."
fi

echo "=== [7/7] Building and starting the app ==="
# Use sudo because the docker group change from step 2 doesn't apply
# to the current shell session without logging out first.
sudo docker compose up -d --build

echo ""
echo "✅ Done! YTGrabber is running."
echo ""
echo "   App URL:  http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):$APP_PORT"
echo "   Logs:     sudo docker compose logs -f"
echo "   Stop:     sudo docker compose down"
echo "   Restart:  sudo docker compose restart"
echo ""
echo "   Note: database migrations run automatically on each container start."
echo "   Tip: log out and back in so future docker commands work without sudo."
echo ""
