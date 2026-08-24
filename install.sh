#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# VPS Assistant — installer for SSH terminals
#
# Quick start (as root on your VPS):
#   bash install.sh                 # guided: asks 2-3 short questions
#
# Non-interactive examples:
#   bash install.sh --domain vps.example.com
#   bash install.sh --public --port 9000 --api-key sk-or-v1-xxxx
#
# Manage later:
#   bash install.sh --status        # is it running? which URL? key set?
#   bash install.sh --update        # refresh app files + restart service
#   bash install.sh --uninstall     # stop & remove service (keeps your data)
#   bash install.sh --uninstall --purge   # ...and delete data too
#
# No dependencies beyond Python 3.10+. Nothing is installed globally except
# /opt/vps-assistant and a systemd unit.
#
# Hidden knobs for testing (env): VPSA_APP_DIR, VPSA_SERVICE_NAME
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${VPSA_APP_DIR:-/opt/vps-assistant}"
SVC="${VPSA_SERVICE_NAME:-vps-assistant}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="8095"
BIND="127.0.0.1"
DOMAIN=""
API_KEY=""
MODE=""          # domain | public | local
PURGE=0

# ---------- pretty printing ----------
if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; N=""
fi
say()  { printf '\n%s==> %s%s\n' "$G$B" "$*$N"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s    ! %s%s\n' "$Y" "$*" "$N"; }
die()  { printf '%s\nERROR: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
hr()   { printf '%s\n' "------------------------------------------------------------"; }

# ---------- flag parsing ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --public)   MODE=public; shift ;;
    --local)    MODE=local; shift ;;
    --domain)   MODE=domain; DOMAIN="${2:?missing value for --domain}"; shift 2 ;;
    --port)     PORT="${2:?missing value for --port}"; shift 2 ;;
    --api-key)  API_KEY="${2:?missing value for --api-key}"; shift 2 ;;
    --uninstall) ACTION=uninstall; shift ;;
    --purge)    PURGE=1; shift ;;
    --status)   ACTION=status; shift ;;
    --update)   ACTION=update; shift ;;
    -h|--help)  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
done
ACTION="${ACTION:-install}"

# ---------- subcommands: status ----------
do_status() {
  META="$APP_DIR/data/install-meta.json"
  MPORT=$(meta_value "$META" port);   [ -n "$MPORT" ] && PORT=$MPORT
  MDOMAIN=$(meta_value "$META" domain)
  MBIND=$(python3 -c "
import re,sys
try:
    t=open('/etc/systemd/system/$SVC.service').read()
    print(re.search(r'VPSA_HOST=(\S+)',t).group(1))
except Exception: print('?')" 2>/dev/null)
  hr
  if systemctl is-active --quiet "$SVC" 2>/dev/null; then
    echo "Service : ${G}running${N} ($SVC)"
  else
    echo "Service : ${R}stopped${N} ($SVC)  — start with: systemctl start $SVC"
  fi
  echo "Install : $APP_DIR"
  echo "Port    : $PORT (bind: ${MBIND:-?})"
  if command -v curl >/dev/null 2>&1; then
    H=$(curl -s -m 3 "http://127.0.0.1:$PORT/health" || true)
    echo "Health  : ${H:-<no answer>}"
  fi
  if [ -s "$APP_DIR/data/openrouter_key" ] || [ -n "${OPENROUTER_API_KEY:-}" ]; then
    echo "API key : configured"
  else
    echo "API key : NOT set yet — click ⚙ in the web UI to add it"
  fi
  if [ -s "$APP_DIR/data/auth.json" ]; then
    echo "Password: set"
  else
    echo "Password: not created yet (first visit to the web UI)"
  fi
  if [ -n "$MDOMAIN" ]; then
    echo "URL     : https://$MDOMAIN  (nginx)"
  fi
  hr
}

# ---------- subcommands: uninstall ----------
meta_value() {  # meta_value <json-file> <key> -> prints value or empty (never fails)
  [ -f "$1" ] || return 0
  python3 -c "
import json
try: print(json.load(open('$1')).get('$2',''))
except Exception: pass" 2>/dev/null || true
}

do_uninstall() {
  say "Stopping and removing the '$SVC' service..."
  systemctl disable --now "$SVC" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SVC.service"
  systemctl daemon-reload
  # remove only OUR nginx vhost (exact domain recorded at install time)
  D=$(meta_value "$APP_DIR/data/install-meta.json" domain)
  if [ -n "$D" ]; then
    rm -f "/etc/nginx/sites-enabled/$D" "/etc/nginx/sites-available/$D"
    systemctl reload nginx 2>/dev/null || true
    info "Removed nginx vhost for $D."
  fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$APP_DIR"
    info "Deleted $APP_DIR (data purged)."
  else
    warn "Kept $APP_DIR (your API key + password live there)."
    warn "Delete it too later with:  $0 --uninstall --purge"
  fi
  say "Uninstalled. The TLS certificate (if any) was left in place."
}

# ---------- preflight ----------
preflight() {
  [ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash $0"
  command -v systemctl >/dev/null || die "systemd not found — this installer targets systemd distros."
  PY=$(command -v python3 || true)
  [ -n "$PY" ] || die "python3 not found. Install it first:  apt install python3"
  "$PY" - <<'EOF' || die "Python 3.10+ required (found $("$PY" --version 2>&1))."
import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)
EOF
  if ss -tln 2>/dev/null | grep -q ":$PORT "; then
    if ! systemctl is-active --quiet "$SVC" 2>/dev/null; then
      die "Port $PORT is already in use by another program.
        See:  ss -tlnp | grep :$PORT
        Pick another:  $0 --port 9000"
    fi
  fi
}

detect_ip() {
  IP=$(curl -s -m 4 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "SERVER_IP")
}

# ---------- interactive mode picker (SSH-friendly) ----------
pick_mode() {
  [ -n "$MODE" ] && return 0
  if [ ! -t 0 ]; then
    MODE=local
    warn "No interactive terminal detected — defaulting to localhost-only mode."
    return 0
  fi
  printf '\n%sHow will you access the assistant?%s\n' "$B" "$N"
  echo "  1) Domain with HTTPS     (recommended — needs a DNS A record)"
  echo "  2) Server IP, password   (quickest — plain HTTP, protected by login)"
  echo "  3) Localhost only        (most private — reach it through an SSH tunnel)"
  printf 'Choice [1]: '
  read -r c </dev/tty || c=1
  case "${c:-1}" in
    1) MODE=domain
       printf 'Domain name (e.g. vps.example.com): '
       read -r DOMAIN </dev/tty || DOMAIN=""
       [ -n "$DOMAIN" ] || die "A domain is required for option 1 (or pick option 2/3)." ;;
    2) MODE=public ;;
    *) MODE=local ;;
  esac
}

ask_api_key() {
  [ -n "$API_KEY" ] && return 0
  if [ -t 0 ]; then
    printf '\n%sOpenRouter API key — used for the AI model.%s\n' "$B" "$N"
    echo "  Create one at https://openrouter.ai/keys (starts with sk-or-v1-)."
    printf 'Paste it now, or press Enter to add it later in the web UI: '
    read -rs k </dev/tty || k=""
    echo
    API_KEY="$k"
  fi
  [ -z "$API_KEY" ] && return 0
  case "$API_KEY" in
    sk-or-*) : ;;
    *) die "That doesn't look like an OpenRouter key (should start with sk-or-v1-)."
  esac
}

save_api_key() {
  [ -n "$API_KEY" ] || return 0
  mkdir -p "$APP_DIR/data"
  printf '%s' "$API_KEY" > "$APP_DIR/data/openrouter_key"
  chmod 600 "$APP_DIR/data/openrouter_key"
  info "API key saved to $APP_DIR/data/openrouter_key (chmod 600)."
}

# ---------- core install ----------
write_unit() {
  cat > "/etc/systemd/system/$SVC.service" <<UNIT
[Unit]
Description=VPS Assistant (chat agent web UI, port $PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=VPSA_PORT=$PORT
Environment=VPSA_HOST=$BIND
ExecStart=$PY $APP_DIR/server.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
}

wait_health() {
  for _ in $(seq 1 15); do
    if command -v curl >/dev/null 2>&1; then
      [ "$(curl -s -m 2 "http://127.0.0.1:$PORT/health")" = '{"ok": true}' ] && return 0
    else
      systemctl is-active --quiet "$SVC" && return 0
    fi
    sleep 1
  done
  return 1
}

do_install() {
  preflight
  detect_ip
  pick_mode
  ask_api_key

  say "Installing app files to $APP_DIR ..."
  mkdir -p "$APP_DIR/static"
  cp "$SRC_DIR/server.py" "$APP_DIR/"
  cp "$SRC_DIR"/static/* "$APP_DIR/static/"
  mkdir -p "$APP_DIR/data"

  save_api_key

  say "Creating systemd service '$SVC' on port $PORT ..."
  write_unit
  systemctl daemon-reload
  systemctl enable --now "$SVC" >/dev/null 2>&1 || systemctl restart "$SVC"

  if wait_health; then
    info "Service is up and answering on 127.0.0.1:$PORT ✔"
  else
    die "Service did not become healthy. Logs:
        journalctl -u $SVC -n 30 --no-pager"
  fi

  # persist how we were installed (used by --status / --uninstall)
  cat > "$APP_DIR/data/install-meta.json" <<META
{"mode": "$MODE", "port": "$PORT", "domain": "$DOMAIN"}
META

  case "$MODE" in
    domain) setup_domain ;;
    public) finish_public ;;
    *)      finish_local ;;
  esac
}

setup_domain() {
  say "Checking DNS for $DOMAIN ..."
  RESOLVED=$(python3 -c "
import socket
try: print(socket.gethostbyname('$DOMAIN'))
except Exception: print('')" 2>/dev/null || echo "")
  LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -z "$RESOLVED" ]; then
    warn "DNS for $DOMAIN is not set up yet."
    warn "Add this record in your DNS panel, then re-run this command:"
    warn "    A record:   $DOMAIN  ->  $IP"
    warn "(the app already works locally meanwhile — see steps below)"
  elif [ "$RESOLVED" != "$IP" ] && [ "$RESOLVED" != "$LOCAL_IP" ]; then
    warn "$DOMAIN currently points to $RESOLVED, but this server is $IP."
    warn "Fix the A record, then re-run:  $0 --domain $DOMAIN"
  else
    say "Configuring nginx + HTTPS for $DOMAIN ..."
    if ! command -v nginx >/dev/null; then
      warn "nginx is not installed. Install and re-run:"
      warn "    apt install -y nginx certbot python3-certbot-nginx && $0 --domain $DOMAIN"
      return 0
    fi
    cat > "/etc/nginx/sites-available/$DOMAIN" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 600;
        proxy_send_timeout 600;
    }
}
NGINX
    ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
    nginx -t && systemctl reload nginx
    if command -v certbot >/dev/null; then
      if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
           --register-unsafely-without-email >/dev/null 2>&1; then
        info "HTTPS is live:  https://$DOMAIN ✔"
        FINAL_URL="https://$DOMAIN"
      else
        warn "Certificate issuance failed (DNS may still be propagating)."
        warn "Retry in a few minutes:  certbot --nginx -d $DOMAIN"
        FINAL_URL="http://$DOMAIN (HTTP only for now)"
      fi
    else
      warn "certbot missing — install it, then:  certbot --nginx -d $DOMAIN"
      FINAL_URL="http://$DOMAIN (HTTP only for now)"
    fi
  fi
  finish_summary
}

finish_public() {
  say "Configuring firewall for direct access ..."
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    if ufw allow "$PORT/tcp" >/dev/null 2>&1; then
      info "ufw: allowed inbound TCP $PORT"
    else
      warn "ufw is active but the rule failed — run manually:  ufw allow $PORT/tcp"
    fi
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if firewall-cmd --add-port="$PORT/tcp" --permanent >/dev/null 2>&1 \
       && firewall-cmd --reload >/dev/null 2>&1; then
      info "firewalld: allowed inbound TCP $PORT"
    else
      warn "firewalld is active but the rule failed — run manually:"
      warn "    firewall-cmd --add-port=$PORT/tcp --permanent && firewall-cmd --reload"
    fi
  else
    info "no local firewall detected (ufw/firewalld inactive)"
  fi

  say "Checking outside reachability ..."
  if command -v curl >/dev/null 2>&1 && [ "$IP" != "SERVER_IP" ]; then
    if curl -s -m 6 "http://$IP:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
      info "http://$IP:$PORT answers from the internet side ✔"
    else
      warn "Could not reach http://$IP:$PORT from this server."
      warn "Most likely cause: your cloud provider's SECURITY GROUP / external"
      warn "firewall does not allow inbound TCP $PORT yet (this installer cannot"
      warn "change that from inside the VM). Examples:"
      warn "  AWS:   EC2 -> Security Groups -> Inbound -> Custom TCP $PORT, source 0.0.0.0/0"
      warn "  GCP:   VPC network -> Firewall -> create rule allowing tcp:$PORT"
      warn "  Azure: Network security group -> Inbound port rule -> add $PORT"
      warn "Note: some providers also block connecting to your OWN public IP from"
      warn "inside the VM — if you've opened $PORT, just test from your phone/laptop."
    fi
  fi
  warn "Plain HTTP: your password protects the app, but HTTPS is safer —"
  warn "when you have a domain, re-run:  $0 --domain YOUR_DOMAIN"
  FINAL_URL="http://$IP:$PORT"
  finish_summary
}

finish_local() {
  FINAL_URL=""
  finish_summary
}

finish_summary() {
  detect_ip
  hr
  echo " ${B}VPS Assistant is installed!${N}"
  hr
  echo " Next steps:"
  n=1
  if [ -n "$FINAL_URL" ]; then
    echo "   $n. Open:  $FINAL_URL"
  else
    echo "   $n. From YOUR laptop, create a tunnel:"
    echo "        ssh -L $PORT:127.0.0.1:$PORT root@$IP"
    echo "      then open:  http://localhost:$PORT"
    echo "      (or re-run with --public or --domain YOUR_DOMAIN anytime)"
  fi
  n=$((n+1))
  if [ -z "$API_KEY" ] && [ ! -s "$APP_DIR/data/openrouter_key" ]; then
    echo "   $n. First visit: create your password."
    n=$((n+1))
    echo "   $n. Click ⚙ → paste your OpenRouter key (https://openrouter.ai/keys)."
  else
    echo "   $n. First visit: create your password — that's it, the API key is already set."
  fi
  n=$((n+1))
  echo "   $n. Chat! Try: \"Check my server health\""
  hr
  echo " Manage:   $0 --status | --update | --uninstall"
  echo " Logs:     journalctl -u $SVC -f"
  hr
}

do_update() {
  say "Updating app files in $APP_DIR ..."
  [ -d "$APP_DIR" ] || die "Not installed yet — run the installer without flags first."
  cp "$SRC_DIR/server.py" "$APP_DIR/"
  cp "$SRC_DIR"/static/* "$APP_DIR/static/"
  systemctl restart "$SVC"
  if wait_health; then
    say "Updated and healthy ✔"
  else
    die "Service unhappy after update — check: journalctl -u $SVC -n 30"
  fi
  do_status
}

# ---------- dispatch ----------
case "$ACTION" in
  status)    do_status ;;
  uninstall) do_uninstall ;;
  update)    do_update ;;
  install)   do_install ;;
esac
