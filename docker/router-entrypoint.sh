#!/bin/sh
# Make mounted volumes writable by `node`, then drop privileges.
#
# The prune matters. The ChatGPT Web bridge keeps a Chromium profile —
# thousands of small files — and it is reasonable to put it inside the same
# volume or NFS export as the router's data, rather than provisioning a second
# one. A plain `chown -R /app/data` then walks that profile on every single
# start: slow over NFS, and it takes ownership away from the bridge, which
# runs as root.
#
# So the profile directory is skipped by name. Everything else is chowned
# exactly as before, and an install without a bridge behaves identically.
set -eu

BRIDGE_PROFILE_DIR="${BRIDGE_PROFILE_DIR_NAME:-chatgpt-web-profile}"

for dir in /app/data /app/data-home; do
  [ -d "$dir" ] || continue
  find "$dir" -name "$BRIDGE_PROFILE_DIR" -prune -o -exec chown node:node {} + 2>/dev/null || true
done

exec su-exec node "$@"
