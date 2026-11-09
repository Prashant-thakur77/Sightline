#!/bin/sh
# On the host: pull main, rebuild what changed, migrate, restart. Usage: deploy/aws/redeploy.sh
set -e
cd /opt/sightline && git pull -q
cd deploy/aws
docker compose build web vision migrate
docker compose run --rm migrate
docker compose up -d
docker image prune -f > /dev/null
