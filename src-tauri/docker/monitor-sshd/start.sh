#!/bin/sh
set -eu
# Match the socket group without changing host socket ownership or permissions.
if [ -S /var/run/docker.sock ]; then
  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
  socket_group="$(awk -F: -v gid="$socket_gid" '$3 == gid { print $1; exit }' /etc/group)"
  if [ -z "$socket_group" ]; then
    addgroup -g "$socket_gid" monitor-docker
    socket_group=monitor-docker
  fi
  addgroup testuser "$socket_group"
fi
exec /usr/sbin/sshd -D -e
