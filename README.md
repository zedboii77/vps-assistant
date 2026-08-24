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
- 📱 Mobile-first dark UI (safe-area aware, no iOS zoom-on-focus)
- ⚡ Live host facts (distro, kernel, mem/disk/CPU, public IP) injected into
  every system prompt
- 🔒 Destructive-action confirmation policy baked into the system prompt

## Quick start

```bash
git clone https://github.com/<you>/vps-assistant.git
cd vps-assistant

# optional: pre-set the key via env instead of the Settings UI
echo "OPENROUTER_API_KEY=sk-or-v1-..." > .env   # not read by server.py directly;
                                                # see systemd unit below

python3 server.py
# → http://127.0.0.1:8095
```

Open the URL, create your password, click ⚙ → paste your OpenRouter API key
(`sk-or-v1-…`), and chat.

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

Templates live in `deploy/`. Typical flow as root:

```bash
mkdir -p /opt/vps-assistant
cp -r . /opt/vps-assistant && rm -rf /opt/vps-assistant/.git

cp deploy/vps-assistant.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now vps-assistant

# nginx: copy deploy/nginx-vhost.conf.example to /etc/nginx/sites-available/,
# adjust server_name, symlink into sites-enabled, then:
certbot --nginx -d vps.example.com
```

The app binds `127.0.0.1` by default — put it behind nginx/TLS rather than
exposing the port. Anyone who can reach this UI can run shell commands as the
service user; keep it behind HTTPS + a strong password.

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
server.py            HTTP server + agent loop + tools (stdlib only)
static/index.html    UI shell
static/app.js        chat frontend (SSE client, mini-markdown)
static/style.css     dark mobile-first theme
deploy/*.service     systemd unit template
deploy/nginx-*       reverse-proxy template
.env.example         environment template
```
