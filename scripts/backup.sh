#!/usr/bin/env bash
# Backup of the whole database (CRM + AI data) into backups/, one file per run.
#   ./scripts/backup.sh 'postgresql://…render.com/crm_xxx?sslmode=require'
# Restore into an empty database (e.g. a new Render database):
#   pg_restore --no-owner --no-privileges -d 'postgresql://…new database…' backups/voronix-2026-11-13_1000.dump
# The file holds clients' names, phones and chats: never commit it or send it around.
set -euo pipefail
URL="${1:-${DATABASE_URL:-}}"
if [ -z "$URL" ]; then
  echo "Usage: ./scripts/backup.sh '<External Database URL>?sslmode=require'" >&2
  exit 1
fi
mkdir -p backups
FILE="backups/voronix-$(date +%Y-%m-%d_%H%M).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$URL"
echo "Saved $FILE ($(du -h "$FILE" | cut -f1))"
# Proof the file is whole: list what it contains.
echo "Tables in the backup: $(pg_restore --list "$FILE" | grep -c ' TABLE ')"
