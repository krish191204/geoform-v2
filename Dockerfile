# syntax=docker/dockerfile:1
# Multi-stage build: stage 1 builds the SPA + installs Python deps,
# stage 2 ships a slim runtime with the built dist/ and venv.

FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3.12-dev \
      nodejs \
      npm \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --upgrade pip wheel setuptools \
 && pip install --no-cache-dir \
      "numpy<3" "noise==1.2.2" protobuf pypng \
      fastapi "uvicorn[standard]" httpx pydantic \
 && pip install --no-cache-dir -e vendor/worldengine

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GEOFORM_API_HOST=0.0.0.0 \
    GEOFORM_API_PORT=8765

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/.venv ./.venv
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/vendor ./vendor
COPY server ./server

ENV PATH="/app/.venv/bin:${PATH}"

EXPOSE 8765 5173

CMD ["python", "-m", "server.api", "--host", "0.0.0.0", "--port", "8765"]
