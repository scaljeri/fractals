# Deployment

This doc covers the **Caddy-on-VM** path: a single VM (or any static host
behind a reverse-proxy) serving the frontend and proxying `/gpu/*` to the
Jetson. The Jetson runs natively, outside the VM.

## Per-machine config (do this first)

Everything env-specific lives in **gitignored** files. Copy the templates and
fill in your values:

```sh
# Browser-side runtime config (production hostname + LAN Jetson URL)
cp frontend/config.example.js frontend/config.local.js

# Frontend deploy target (rsync over SSH)
cp frontend/.env.example frontend/.env

# Jetson SSH target + remote path (used by jetson/scripts/deploy.sh)
cp jetson/.env.example jetson/.env
```

The tracked code reads from `window.MANDELBROT_CONFIG` (set by
`config.local.js`) and falls back to safe defaults if the file is absent — so a
fresh clone runs out of the box, just without the production-hostname shortcut.

## Overview

```
                     ┌──────────────────────────────┐
                     │  <your-domain> (Caddy)       │
  Browser ──HTTPS──▶ │                              │
                     │  /        → static files     │
                     │  /gpu/*   → Jetson Orin      │
                     └──────────────────────────────┘
                                      │
                              (LAN / tunnel)
                                      ▼
                            ┌────────────────────┐
                            │  Jetson Orin AGX   │
                            │  :8080 render svc  │
                            └────────────────────┘
```

The frontend (`index.html`, `main.js`) is fully static — it detects whether it
is served from `MANDELBROT_CONFIG.productionHost` or not and points the Jetson
URL accordingly:

| Context | Jetson URL used |
|---|---|
| `https://<your-domain>/` (matches `productionHost`) | `https://<your-domain>/gpu` (same-origin reverse proxy) |
| `http://localhost:8765/` (local dev) | `MANDELBROT_CONFIG.lanJetsonUrl`, or `localStorage.jetsonUrl`, or prompt |

If the Jetson is unreachable (home network offline, service down, etc.) the
browser hides the `jetson` button entirely. It rechecks every 30 s so the
button reappears when the Jetson comes back.

---

## 1. Host the static browser app

The app has no build step — just serve `frontend/` contents. Any static host
works: Caddy `file_server`, nginx, GitHub Pages, Cloudflare Pages, etc.

For an `rsync`-over-SSH deploy, fill in `frontend/.env` and run:

```sh
cd frontend
./scripts/deploy.sh             # rsync to $DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR
./scripts/deploy.sh --dry-run   # preview without copying
```

The script excludes `node_modules/`, test helpers, `*.ppm` outputs, and the
gitignored `.env` / `config.local.js` themselves.

## 2. Configure Caddy (or nginx) reverse-proxy

See `Caddyfile.example` at the repo root. Short version:

```caddy
<your-domain> {
    root * /var/www/mandelbrot
    file_server
    handle_path /gpu/* {
        reverse_proxy <jetson-ip>:8080 {
            transport http { read_timeout 1h write_timeout 1h }
        }
    }
    encode gzip
}
```

- Replace `<your-domain>` and `<jetson-ip>` with your real values.
- Long `read_timeout` / `write_timeout` let 60-minute renders survive and large
  mp4 downloads complete without being cut off.

Deploy:
```sh
sudo cp Caddyfile.example /etc/caddy/Caddyfile
# edit /etc/caddy/Caddyfile to substitute the placeholders
sudo systemctl reload caddy
```

## 3. Reach the Jetson from the Caddy host

If Caddy and the Jetson are on the same LAN: nothing special needed.

If Caddy runs in the cloud and the Jetson is at home: use a tunnel:
- **Tailscale** (easiest): join both machines to a tailnet. Use Tailscale IP as `<jetson-ip>`.
- **Cloudflare Tunnel / `cloudflared`**: expose Jetson `:8080` through your CF account.
- **Wireguard**: self-hosted VPN.
- **Port-forward 8080 on your home router**: works but exposes the service to the internet; prefer one of the above.

## 4. Run the Jetson backend

See `jetson/README.md` for details. Short version:

```sh
# On the Jetson
cd ~/mandelbrot/jetson
bash run.sh setup   # first time only
bash run.sh         # or enable the systemd unit for auto-start
```

Test from the Caddy host:
```sh
curl http://<jetson-ip>:8080/jobs
# or from the internet
curl https://<your-domain>/gpu/jobs
```

Both should return `{"current":null,"queue_size":0,"jobs":[]}`.

## 5. Local development

Nothing changes for local dev. Run the static app via any HTTP server:

```sh
cd frontend
python3 -m http.server 8765
```

Open `http://localhost:8765` — if `config.local.js` sets `lanJetsonUrl`, the
page uses that directly. Otherwise the first time you click the `jetson`
button you get a prompt asking for the Jetson URL (stored in localStorage
thereafter).

When you want to test against the prod Jetson route while developing locally,
manually set the URL to `https://<your-domain>/gpu` in the prompt, or clear
localStorage and set it directly in the dev tools.

---

## CORS notes

- Production (`<your-domain>/gpu`): same-origin, no CORS needed.
- Local dev (`localhost:8765` → `<jetson-ip>:8080`): cross-origin. The Jetson
  FastAPI already sets `allow_origins=["*"]` in `src/server.py`.

## Security notes

The Jetson API currently has no authentication. On a trusted LAN this is fine.
When exposed via Caddy to the public internet, consider:

- Caddy basic auth on `/gpu/*`:
  ```caddy
  handle_path /gpu/* {
      basicauth {
          someuser <bcrypt hash of password>
      }
      reverse_proxy <jetson-ip>:8080
  }
  ```
- Or keep `/gpu/*` behind a tunnel (Tailscale exit node, CF Access, etc.) so
  only authenticated users reach it.
