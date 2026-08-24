# vps-assistant

A small, dedicated chat agent web UI for VPS management — powered by any
OpenRouter chat model (default: `stealth/ox-alpha`).

You sign in from your browser (desktop or phone), chat in plain language, and
the agent runs real commands on the server: checking services, reading logs,
patching configs, restarting units — then reports back with the output.

**Zero dependencies.** Pure Python 3 stdlib (server) + vanilla JS (frontend).
No npm, no pip, no build step.

## Features

- 🔐 Single-user password auth (first visit = setup, HMAC-signed session cookie,
  login rate limiting)
- 🤖 OpenRouter streaming chat with any model slug
- 🛠️ Agent tool loop: `shell`, `read_file`, `write_file` — up to 12 tool rounds
  per message, with live tool-call chips in the UI
- 📱 Mobile-first monochrome terminal UI (prompt-line chat, ASCII boot screen;
  errors stay red)
- 🎙 Voice dictation via the browser's built-in speech API (mic button; hidden
  where unsupported)
- ⚡ Live host facts (distro, kernel, mem/disk/CPU, public IP) injected into
  every system prompt
- 🔒 Destructive-action confirmation policy baked into the system prompt

## Quick start (SSH terminal)

```bash
git clone https://github.com/<you>/vps-assistant.git
cd vps-assistant
sudo bash install.sh        # then answer 2–3 short questions
```

The installer asks how you'll access the UI (**domain + HTTPS** / **server IP**
/ **localhost only**), optionally takes your OpenRouter key up front, creates a
systemd service, health-checks it, and prints your exact next steps — including
the SSH tunnel command if you chose localhost mode.

Prefer zero questions?

```bash
sudo bash install.sh --domain vps.example.com     # needs a DNS A record first
sudo bash install.sh --public                     # http://SERVER_IP:8095 (default port)
sudo bash install.sh --public --port 9000         # any custom port works too
sudo bash install.sh --api-key «redacted:sk-…»      # pre-set the model key
```

Manage an existing install any time:

```bash
bash install.sh --status                # running? URL? key/password set?
bash install.sh --update                # refresh app files + restart
bash install.sh --uninstall             # remove service (keeps data)
bash install.sh --uninstall --purge     # ...and delete data too
```

Run without installing (dev):

```bash
python3 server.py           # http://127.0.0.1:8095
```

> The API key is stored server-side in `data/openrouter_key` (chmod 600) or
> provided via the `OPENROUTER_API_KEY` environment variable. Get one at
> <https://openrouter.ai/keys>.

## Configuration (environment)

| Var                  | Default            | Notes                          |
|----------------------|--------------------|--------------------------------|
| `VPSA_PORT`          | `8095`             | HTTP port                      |
| `VPSA_HOST`          | `127.0.0.1`        | Bind address (keep loopback!)  |
| `VPSA_DATA_DIR`      | `<repo>/data`      | Auth + key storage             |
| `VPSA_MODEL`         | `stealth/ox-alpha` | Any OpenRouter model slug      |
| `OPENROUTER_API_KEY` | —                  | Overrides the Settings-UI key  |

## Production deploy (systemd + nginx)

**You need:** a VPS with systemd, Python 3.10+, and a domain whose **A record
points at the server's IP** (check: `dig +short YOUR_DOMAIN`).

### Option A — one command (recommended)

```bash
sudo bash install.sh --domain YOUR_DOMAIN
```

That's it — the installer configures nginx, obtains the TLS certificate,
creates and health-checks the service, and prints your next steps.

### Option B — manual (if you'd rather see every step)

```bash
# 1. Copy the app to /opt
sudo mkdir -p /opt/vps-assistant/static /opt/vps-assistant/data
sudo cp server.py /opt/vps-assistant/
sudo cp static/* /opt/vps-assistant/static/

# 2. Install and start the service
sudo cp deploy/vps-assistant.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vps-assistant
curl http://127.0.0.1:8095/health        # → {"ok": true}

# 3. Set up nginx (HTTP first — the cert doesn't exist yet)
#    Replace YOUR_DOMAIN in deploy/nginx-vhttp-bootstrap.conf, then:
sudo cp deploy/nginx-vhttp-bootstrap.conf /etc/nginx/sites-available/YOUR_DOMAIN
sudo ln -s /etc/nginx/sites-available/YOUR_DOMAIN /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. Add TLS (certbot edits the vhost and adds the HTTPS block itself)
sudo apt install -y certbot python3-certbot-nginx   # if missing
sudo certbot --nginx -d YOUR_DOMAIN

# 5. Verify
curl https://YOUR_DOMAIN/health          # → {"ok": true}
```

Then open `https://YOUR_DOMAIN`, create your password, and (if you didn't set
`--api-key` or `OPENROUTER_API_KEY`) add your OpenRouter key via ⚙ Settings.

The app binds `127.0.0.1` by default — put it behind nginx/TLS rather than
exposing the port. Anyone who can reach this UI can run shell commands as the
service user; keep it behind HTTPS + a strong password.

## Uninstall

### Installed via `install.sh`

From the repo directory (or any copy of `install.sh`):

```bash
sudo bash install.sh --uninstall            # remove service + nginx vhost, keep your data
sudo bash install.sh --uninstall --purge    # ...and also delete all data
```

What this removes:

| Removed                                   | Kept (unless `--purge`)                     |
|-------------------------------------------|---------------------------------------------|
| `vps-assistant` systemd unit (stopped)    | `/opt/vps-assistant/data/` — your API key,  |
| Its nginx vhost (only the domain it       | password hash and session secret            |
| recorded at install time)                 | The TLS certificate (`/etc/letsencrypt/…`)  |

After a `--purge`, nothing of the app remains on the machine except possibly
the TLS certificate — see below if you want that gone too.

> Your OpenRouter key is **not** revoked by uninstalling. If it was stored on
> the server, also delete/disable it at <https://openrouter.ai/keys>.

### Manual cleanup (template-based installs)

If you deployed manually from `deploy/` instead:

```bash
systemctl disable --now vps-assistant
sudo rm -f /etc/systemd/system/vps-assistant.service && sudo systemctl daemon-reload

# nginx vhost (adjust the domain)
sudo rm -f /etc/nginx/sites-enabled/vps.example.com \
           /etc/nginx/sites-available/vps.example.com
sudo systemctl reload nginx

# optional: app files + data (API key, password)
sudo rm -rf /opt/vps-assistant

# optional: release the TLS certificate
sudo certbot delete --cert-name vps.example.com
```

Finally, if you added a DNS A record for the app, delete it in your DNS panel
whenever you like.

## Security notes

- Session cookies are HMAC-signed (`data/session_secret`, chmod 600), HttpOnly,
  SameSite=Lax, Secure behind TLS.
- Passwords: salted SHA-256 (fine for single-user; rate limited to 10 tries /
  10 min per IP).
- Tool output sent to the model is capped (8 KB stdout / 24 KB per tool result)
  so a runaway command can't blow up context.
- The shell tool runs as the service user (root if you deploy as root —
  consider a dedicated user + targeted sudo rules if that worries you).

## Repo layout

```
install.sh           one-command installer / status / update / uninstall
server.py            HTTP server + agent loop + tools (stdlib only)
static/index.html    UI shell
static/app.js        chat frontend (SSE client, mini-markdown)
static/style.css     dark mobile-first theme
deploy/*.service     systemd unit template
deploy/nginx-*       reverse-proxy template
.env.example         environment template
```
