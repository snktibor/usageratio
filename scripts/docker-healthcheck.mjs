#!/usr/bin/env node
// The Dockerfile's HEALTHCHECK: a plain `fetch` against /api/health (see
// app/api/health/route.ts) so the image needs no extra HTTP client (wget is
// on Alpine, but this avoids depending on it). Exit 0 on a 200, 1 otherwise
// — matching what `docker ps` and `depends_on: condition: service_healthy`
// (docker-compose.yml) expect.

const port = process.env.PORT || 3000;
const url = `http://127.0.0.1:${port}/api/health`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) {
    console.error(`docker-healthcheck: ${url} -> ${response.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`docker-healthcheck: ${url} failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
