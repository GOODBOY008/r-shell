# SSH server with X11 forwarding enabled — for R-Shell X11 E2E testing.
#
# Provides an sshd configured to accept X11 forwarding requests, so the
# R-Shell Rust integration test can validate the full path:
#   connect → request_x11 (accepted) → sshd sets remote $DISPLAY.
#
# NOT for production: known password, host-key auto-accepted by the client.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# openssh-server: the thing under test.
# xauth: required server-side so sshd can manage the fake MIT-MAGIC-COOKIE
#        when an untrusted X11 forwarding session starts (without xauth,
#        sshd refuses X11 forwarding with "Could not run xauth").
# x11-apps: provides `xlogo`/`xeyes` so a test can force an inbound X11
#           channel by launching an X client that connects to $DISPLAY.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server \
        xauth \
        x11-apps \
    && rm -rf /var/lib/apt/lists/*

# Test user — matches the credentials in src-tauri/src/ssh/tests.rs.
RUN useradd -m -s /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd

# sshd runtime dir.
RUN mkdir -p /run/sshd

# Generate host keys (client auto-accepts them in tests).
RUN ssh-keygen -A

# Configure sshd for X11 forwarding.
#   X11Forwarding yes        — the core requirement.
#   X11DisplayOffset 10      — remote DISPLAY starts at localhost:10.0.
#   X11UseLocalhost no       — sshd listens on all interfaces so the
#                              forwarded X port is reachable; with `yes`
#                              (default) it binds loopback inside the
#                              container only, which still works for our
#                              bridge but `no` matches a typical setup.
#   PasswordAuthentication yes — test uses password auth.
RUN sed -i \
    -e 's/^#\?X11Forwarding.*/X11Forwarding yes/' \
    -e 's/^#\?X11DisplayOffset.*/X11DisplayOffset 10/' \
    -e 's/^#\?X11UseLocalhost.*/X11UseLocalhost no/' \
    -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' \
    /etc/ssh/sshd_config

EXPOSE 22

# Run sshd in the foreground (not daemonized) so the container stays alive.
CMD ["/usr/sbin/sshd", "-D", "-e"]
