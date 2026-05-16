# mandelbrot Helm chart

Deploys the Mandelbrot frontend (Caddy serving the static WebGPU app) to a
k3s cluster. The Jetson render backend stays **outside** the cluster — the
chart wires it in as an ExternalName Service and routes `/gpu/*` to it via a
Traefik StripPrefix middleware.

## Prerequisites

- A k3s (or k8s) cluster with Traefik as the IngressController (default on k3s)
- `cert-manager` installed with a working `ClusterIssuer` (e.g. `letsencrypt-prod`) — optional, for TLS
- DNS for `hostname` pointing at the cluster's ingress IP
- The frontend container image built and pushed to a registry the cluster can pull from

## Install

```bash
helm install mandelbrot ./helm/mandelbrot \
  --namespace mandelbrot --create-namespace \
  -f my-values.yaml
```

Example `my-values.yaml`:

```yaml
hostname: mandelbrot.example.com

image:
  repository: ghcr.io/you/mandelbrot
  tag: "2026-04-19"

jetson:
  externalHost: jetson.tail-xyz.ts.net
  externalPort: 8080
  externalScheme: http

ingress:
  tls:
    enabled: true
    clusterIssuer: letsencrypt-prod
```

## Upgrade

```bash
helm upgrade mandelbrot ./helm/mandelbrot -n mandelbrot -f my-values.yaml
```

## Uninstall

```bash
helm uninstall mandelbrot -n mandelbrot
```

## How the Jetson routing works

The Jetson is not a pod in the cluster. The chart creates a
`Service: ExternalName` that resolves to `jetson.externalHost`, then the
Ingress has a `/gpu` rule pointing at that Service. A Traefik `Middleware`
(kind: `Middleware`, from `traefik.io/v1alpha1`) strips the `/gpu` prefix so
the backend sees its normal paths (`/render`, `/jobs/…`, `/download/…`).

To disable the `/gpu` route entirely, leave `jetson.externalHost` empty —
the frontend's health check will automatically hide the GPU-record button.

## Building the frontend image

From the repo root:

```bash
docker build -t ghcr.io/you/mandelbrot:TAG .
docker push ghcr.io/you/mandelbrot:TAG
```

The repo-root `Dockerfile` copies `frontend/` + `Caddyfile` into a
`caddy:2-alpine` image. The `handle_path /gpu/*` block in the Caddyfile is
only used in local `docker compose` dev — in k3s, the Ingress does the
proxying and the Caddy container only serves static files.
