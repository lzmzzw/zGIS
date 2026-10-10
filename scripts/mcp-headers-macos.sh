#!/bin/sh
# 仅由 Codex http_headers_helper 调用；不要手动运行或记录标准输出。
set -eu
fail() {
  printf '%s\n' 'zGIS MCP credential unavailable. Start zGIS and enable its MCP service.' >&2
  exit 1
}
access_token=$(/usr/bin/security find-generic-password -s zGIS -a zGIS/MCP -w 2>/dev/null) || fail
printf '%s' "$access_token" | /usr/bin/grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || fail
printf '{"Authorization":"Bearer %s"}\n' "$access_token"
unset access_token
