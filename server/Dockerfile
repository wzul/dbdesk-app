# DB Desk Server — the same app, hosted.
#
# Two stages: Node builds the UI bundle, Python runs the sidecar API and serves it.
# The result is a single image with no Node in it, running as a non-root user, and
# listening on 8080 behind your own TLS terminator (Caddy, Traefik, nginx).

FROM node:26-alpine AS ui
WORKDIR /src
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DBDESK_SERVER=1 \
    DBDESK_HOME=/data \
    HOST=0.0.0.0 \
    PORT=8080

# psql is not required, but the image keeps a copy of the postgres client so the
# psql fallback path works when someone disables the bundled driver.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip && python -m pip install -r requirements.txt

COPY backend/ ./backend/
COPY --from=ui /src/dist ./ui/dist

RUN useradd --create-home --uid 10001 dbdesk \
 && mkdir -p /data && chown -R dbdesk:dbdesk /data /app
USER dbdesk

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

WORKDIR /app/backend
CMD ["python", "app.py"]
