#!/usr/bin/env bash
# Matterport In3D — sestaví Docker image a spustí aplikaci.
#
#   ./start.sh            # build + start (image dle .env MP_DOCKER_TARGET, default slim)
#   ./start.sh --rebuild  # totéž, vždy bez cache
#
# Aplikace pak běží na http://localhost:8017 (bind na všechna rozhraní —
# dosažitelné i jako http://<hostname>:8017 z jiných zařízení; plný SDK
# náhled ze vzdáleného stroje přes SSH tunel, viz README „Provoz v síti“).
#
# Kontejner běží jako uživatel hostitele (uid 1000) — soubory v mountnutém
# data/ nepatří rootovi a host si je může číst/upravovat.
set -euo pipefail
cd "$(dirname "$0")"

REBUILD=""
if [[ "${1:-}" == "--rebuild" ]]; then
  REBUILD="--no-cache"
fi

echo "==> Build image (target: ${MP_DOCKER_TARGET:-slim})…"
docker compose build $REBUILD app

echo "==> Start kontejnerů…"
docker compose up -d app

echo "==> Čekám na health (/health)…"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://localhost:8017/health 2>/dev/null; then
    echo "==> OK — aplikace běží"
    break
  fi
  sleep 1
done

if ! curl -fsS -o /dev/null http://localhost:8017/health 2>/dev/null; then
  echo "!! Aplikace neodpovídá na http://localhost:8017/health —"
  echo "!! podívejte se do logů:  docker compose logs app"
  exit 1
fi

# Kontrola práv v mountnutém data/ — root-owned soubory z předchozích běhů
# (kontejner kdysi běžel jako root) by export/čtení blokovaly
ROOT_FILES=$(find data -user root 2>/dev/null | head -5 || true)
if [[ -n "$ROOT_FILES" ]]; then
  echo "!! POZOR: v data/ jsou soubory vlastněné rootem (kontejner je nemůže číst jako uid 1000):"
  echo "$ROOT_FILES"
  echo "   Oprava:  sudo chown -R $(id -u):$(id -g) data/"
  exit 1
fi

echo ""
echo "Spustit:    http://localhost:8017"
echo "Logy:       docker compose logs -f app"
echo "Export IFC: http://localhost:8017/export/ifc  (nebo tlačítko „Export IFC“ v záložce Inventář)"
