#!/usr/bin/env bash
# Publish a locally built data directory (output of appa_live2.build / pipeline) to the web server.
# The order matters: new run files first, pointers (latest.json, runs.json) last, pruning after,
# so visitors never see a half-uploaded run.
#
#   deploy/push_data.sh /path/to/web/data  deploy@appa-server:/srv/appa-data
set -euo pipefail
SRC="${1:?local data directory}"; DEST="${2:?remote user@host:/srv/appa-data}"
SRC="${SRC%/}"

rsync -a --partial --exclude '.*.partial' --exclude 'latest.json' --exclude 'runs.json' "$SRC/runs/" "$DEST/runs/"
rsync -a "$SRC/latest.json" "$SRC/runs.json" "$DEST/"
rsync -a --delete --exclude '.*.partial' "$SRC/runs/" "$DEST/runs/"   # drop runs that were pruned locally
