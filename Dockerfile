# Production image for the frontend + reverse-proxy. Used by the Helm chart.
# Local dev uses the same Caddyfile via bind-mount in docker-compose.yml.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY frontend/ /srv/

EXPOSE 80
