#!/usr/bin/env bash
# One-time host setup (idempotent): Docker, 1 GB swap, /opt/support-ai/.env with generated secrets.
# Run by infra/setup.sh as: ssh ubuntu@HOST "sudo OPENAI_API_KEY=... bash -s" < deploy/bootstrap.sh
set -euo pipefail
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; usermod -aG docker ubuntu; }
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf && sysctl -p /etc/sysctl.d/99-swap.conf
fi
mkdir -p /opt/support-ai && chown ubuntu:ubuntu /opt/support-ai
env=/opt/support-ai/.env
if [ ! -f "$env" ]; then
  : "${OPENAI_API_KEY:?OPENAI_API_KEY must be set for the first bootstrap}"
  rnd() { openssl rand -hex "$1"; }

  umask 077
  cat > "$env" <<ENV
POSTGRES_PASSWORD=$(rnd 24)
JWT_SECRET=$(rnd 32)
ADMIN_API_KEY=$(rnd 24)
OPENAI_API_KEY=$OPENAI_API_KEY
WEB_ORIGIN=${WEB_ORIGIN:-https://support-ai-web-smoky.vercel.app}
API_HOST=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]' | tr . -).sslip.io
REQUIRE_EMAIL_VERIFICATION=false
DAILY_AI_BUDGET_USD=5
LOG_LEVEL=info
ENV
  chown ubuntu:ubuntu "$env"
fi
echo "bootstrap ok"
