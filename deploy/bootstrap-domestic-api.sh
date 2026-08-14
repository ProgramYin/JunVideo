#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/opt/JunVideo}"
REPO_URL="${REPO_URL:-https://github.com/ProgramYin/JunVideo.git}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash deploy/bootstrap-domestic-api.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git nginx certbot python3-certbot-nginx ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose Plugin is required. Install it, then rerun this script." >&2
  exit 1
fi

if [[ -d "${REPO_DIR}/.git" ]]; then
  git -C "${REPO_DIR}" pull --ff-only origin main
else
  install -d -m 0755 "$(dirname "${REPO_DIR}")"
  git clone "${REPO_URL}" "${REPO_DIR}"
fi

cd "${REPO_DIR}"
if [[ ! -f .env.domestic-api ]]; then
  install -m 0600 .env.domestic-api.example .env.domestic-api
  echo "Created ${REPO_DIR}/.env.domestic-api. Fill its secrets and rerun this script."
  exit 0
fi

ufw allow 80/tcp >/dev/null || true
ufw allow 443/tcp >/dev/null || true

docker compose -f docker-compose.domestic.yml up -d --build
curl --fail --silent --show-error http://127.0.0.1:8080/api/health
echo

if [[ -n "${API_DOMAIN:-}" ]]; then
  install -m 0644 deploy/nginx/junvideo-api.conf /etc/nginx/sites-available/junvideo-api
  sed -i "s/api\\.example\\.cn/${API_DOMAIN}/g" /etc/nginx/sites-available/junvideo-api
  ln -sfn /etc/nginx/sites-available/junvideo-api /etc/nginx/sites-enabled/junvideo-api
  nginx -t
  systemctl reload nginx
  echo "Nginx is ready for ${API_DOMAIN}. Run: certbot --nginx -d ${API_DOMAIN}"
else
  echo "Set API_DOMAIN and rerun the Nginx setup after DNS points to this host."
fi
