#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# VPS Assistant — one-command installer
#
# Usage (as root on your VPS):
#   bash install.sh                 # safe default: localhost only (SSH tunnel)
#   bash install.sh --public        # reachable at http://SERVER_IP:8095
#   bash install.sh --port 9000     # custom port
#   bash install.sh --domain vps.example.com   # also configures nginx + HTTPS
#
# What it does: checks Python 3.10+, copies the app to /opt/vps-assistant,
# creates and starts a systemd service, and prints what to do next.
# No packages are installed beyond what your distro already has.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/vps-assistant
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${VPSA_PORT:-8095}"
BIND=127.0.0.1
DOMAIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public) BIND=0.0.0.0; shift ;;
    --port)   PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Please run as root:  sudo bash install.sh"; exit 1; }

say "Checking Python 3..."
PY=$(command -v python3 || true)
[[ -n $PY ]] || { echo "python3 not found. Install it first:  apt install python3"; exit 1; }
$PY - <<'EOF' || { echo "Python 3.10+ required."; exit 1; }
import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)
EOF
echo "Found $($PY --version)"

say "Installing app files to $APP_DIR ..."
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR"/server.py "$SRC_DIR"/static "$SRC_DIR"/deploy "$SRC_DIR"/README.md \
      "$SRC_DIR"/.env.example "$APP_DIR"/ 2>/dev/null || true

say "Creating systemd service (vps-assistant, port $PORT) ..."
sed -e "s/^Environment=VPSA_PORT=.*/Environment=VPSA_PORT=$PORT/" \
    -e "s|^ExecStart=.*|ExecStart=$PY $APP_DIR/server.py|" \
    "$SRC_DIR/deploy/vps-assistant.service" > /etc/systemd/system/vps-assistant.service
if [[ $BIND == 0.0.0.0 ]]; then
  sed -i 's/^Environment=VPSA_HOST=.*/Environment=VPSA_HOST=0.0.0.0/' \
    /etc/systemd/system/vps-assistant.service
fi
systemctl daemon-reload
systemctl enable --now vps-assistant
sleep 1
systemctl is-active --quiet vps-assistant && echo "Service is running." \
  || { echo "Service failed to start:"; journalctl -u vps-assistant -n 20 --no-pager; exit 1; }

if [[ -n $DOMAIN ]]; then
  say "Configuring nginx for $DOMAIN ..."
  command -v nginx >/dev/null || { echo "nginx not installed — skipping web config."; }
  if command -v nginx >/dev/null; then
    sed "s/vps\.example\.com/$DOMAIN/g; s/127\.0\.0\.1:8095/127.0.0.1:$PORT/g" \
      "$SRC_DIR/deploy/nginx-vhost.conf.example" > "/etc/nginx/sites-available/$DOMAIN"
    ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
    nginx -t && systemctl reload nginx
    if command -v certbot >/dev/null; then
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
        --register-unsafely-without-email 2>/dev/null || \
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos || \
        echo "certbot failed — make sure DNS for $DOMAIN points at this server, then re-run: certbot --nginx -d $DOMAIN"
    else
      echo "certbot not installed — install it and run: certbot --nginx -d $DOMAIN"
    fi
    echo "Open https://$DOMAIN"
  fi
fi

cat <<EOF

------------------------------------------------------------
 VPS Assistant is installed! 🎉

 Next steps:
   1. Open the app:
EOF
if [[ $BIND == 0.0.0.0 ]]; then
  IP=$(curl -s --max-time 5 https://api.ipify.org || echo SERVER_IP)
  echo "        http://$IP:$PORT"
  echo "        (protected by a password you will create on first visit;"
  echo "         for real security later, add a domain + HTTPS: rerun with --domain YOUR_DOMAIN)"
else
  echo "        It listens on localhost only. From YOUR laptop run:"
  echo "           ssh -L 8095:127.0.0.1:$PORT root@SERVER_IP"
  echo "        then open  http://localhost:8095"
  echo "        Or re-run with --public (open port) or --domain YOUR_DOMAIN (optional, adds HTTPS via nginx)"
fi
cat <<'EOF'
   2. Create your password when prompted (first visit).
   3. Click ⚙ Settings → paste your OpenRouter API key (sk-or-v1-...).
      Get one at https://openrouter.ai/keys
   4. Chat! Try: "Check my server health"

 Manage the service:
   systemctl status|restart|stop vps-assistant
   journalctl -u vps-assistant -f        # live logs
------------------------------------------------------------
EOF
