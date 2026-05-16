# Deployment: mandelbrot.calje.eu

This doc covers two deployment paths:

1. **Caddy-on-VM** (sections 1–5 below) — single VM running Caddy as both static
   host and reverse-proxy. Simple, no Kubernetes needed.
2. **Helm on k3s** (see the end of this file and
   [helm/mandelbrot/README.md](helm/mandelbrot/README.md)) — frontend runs as a
   Deployment behind Traefik, Jetson wired in via ExternalName Service.

Both paths keep the **Jetson native (outside the cluster/VM)**. Pick whichever
matches your infra.

## Overview

```
                     ┌──────────────────────────────┐
                     │  mandelbrot.calje.eu (Caddy) │
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
is served from the production hostname (`mandelbrot.calje.eu`) or not and
points the Jetson URL accordingly:

| Context | Jetson URL used |
|---|---|
| `https://mandelbrot.calje.eu/` | `https://mandelbrot.calje.eu/gpu` (same-origin reverse proxy) |
| `http://localhost:8765/` (local dev) | from `localStorage.jetsonUrl`, or prompted once |

If the Jetson is unreachable (home network offline, service down, etc.) the
browser hides the `jetson` button entirely. It rechecks every 30 s so the
button reappears when the Jetson comes back.

---

## 1. Host the static browser app

The app has no build step — just serve `index.html` + `main.js`. Any static
host works: Caddy `file_server`, nginx, GitHub Pages, Cloudflare Pages, etc.

Minimum files:
```
index.html
main.js
```

## 2. Configure Caddy (or nginx) reverse-proxy

See `Caddyfile.example` at the repo root. Short version:

```caddy
mandelbrot.calje.eu {
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

- Replace `<jetson-ip>` with your Jetson's LAN IP (or Tailscale / Wireguard address).
- Long `read_timeout` / `write_timeout` let 60-minute renders survive and large
  mp4 downloads complete without being cut off.

Deploy:
```sh
sudo cp Caddyfile.example /etc/caddy/Caddyfile
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
curl https://mandelbrot.calje.eu/gpu/jobs
```

Both should return `{"current":null,"queue_size":0,"jobs":[]}`.

## 5. Local development

Nothing changes for local dev. Run the static app via any HTTP server:

```sh
cd /Users/luca/dev/mandelbrot/frontend
python3 -m http.server 8765
```

Open `http://localhost:8765` — the first time you click the `jetson` button you
get a prompt asking for the Jetson URL (stored in localStorage thereafter).

When you want to test against the prod Jetson route while developing locally,
manually set the URL to `https://mandelbrot.calje.eu/gpu` in the prompt, or
clear localStorage and set it directly in the dev tools.

---

## CORS notes

- Production (`mandelbrot.calje.eu/gpu`): same-origin, no CORS needed.
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

---

## Alternative: Helm on k3s

Instead of Caddy-on-VM, the same frontend can be deployed to a k3s cluster
using the Helm chart under [helm/mandelbrot/](helm/mandelbrot/). The Jetson
still runs natively (step 4 above stays the same) — the chart creates a
`Service: ExternalName` pointing at the Jetson host and a Traefik
StripPrefix middleware so the Ingress can route `/gpu/*` to it.

### 1. Build + push the frontend image

```sh
docker build -t ghcr.io/you/mandelbrot:TAG .
docker push ghcr.io/you/mandelbrot:TAG
```

The repo-root `Dockerfile` copies `frontend/` + `Caddyfile` into
`caddy:2-alpine`. In k3s the Caddyfile's `/gpu` block is unused — the Ingress
does the proxying — but keeping one image means local dev and standalone
Caddy-on-VM both use the same artifact.

### 2. Install the chart

```sh
helm install mandelbrot ./helm/mandelbrot \
  --namespace mandelbrot --create-namespace \
  -f my-values.yaml
```

Minimum `my-values.yaml`:
```yaml
hostname: mandelbrot.calje.eu
image:
  repository: ghcr.io/you/mandelbrot
  tag: "TAG"
jetson:
  externalHost: jetson.tail-xyz.ts.net   # LAN IP, Tailscale name, or tunnel
  externalPort: 8080
ingress:
  tls:
    enabled: true
    clusterIssuer: letsencrypt-prod
```

### 3. Verify

```sh
kubectl get pods -n mandelbrot
kubectl get ingress -n mandelbrot
curl https://mandelbrot.calje.eu/
curl https://mandelbrot.calje.eu/gpu/jobs
```

Full install/upgrade/uninstall guide and all values:
[helm/mandelbrot/README.md](helm/mandelbrot/README.md).
