#!/bin/sh
# Every 15 minutes from cron: hold deadlines, photo retention, webhook retries.
. /opt/sightline/deploy/aws/.env
curl -fsS -m 120 -X POST -H "authorization: Bearer $MAINTENANCE_TOKEN" https://sightline.prashantthakur.dev/api/maintenance
