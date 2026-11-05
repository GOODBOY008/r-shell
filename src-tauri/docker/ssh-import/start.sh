#!/bin/sh
set -eu
ssh-keygen -A
for user in jumpone jumptwo target legacyrsa; do
  mkdir -p "/home/$user/.ssh"
  cat "/keys/$user.pub" > "/home/$user/.ssh/authorized_keys"
  if [ "$user" = target ]; then cat /keys/target-locked.pub >> "/home/$user/.ssh/authorized_keys"; fi
  chmod 700 "/home/$user/.ssh"
  chmod 600 "/home/$user/.ssh/authorized_keys"
  chown -R "$user:$user" "/home/$user/.ssh"
done
exec /usr/sbin/sshd -D -e
