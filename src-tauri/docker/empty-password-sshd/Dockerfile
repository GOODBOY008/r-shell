# Fixture for the passwordless-host integration tests in src/ssh/tests.rs
# (issue #122). An Alpine OpenSSH server with user 'pi' whose password is
# EMPTY and PermitEmptyPasswords enabled — mirrors the Raspberry Pi style
# devices users report connecting to.
#
# Build & run:
#   docker build -t rshell-empty-pass-sshd src-tauri/docker/empty-password-sshd
#   docker run -d --name rshell-sshd-empty -p 2222:22 rshell-empty-pass-sshd
FROM alpine:3.19

RUN apk add --no-cache openssh shadow

# User 'pi' with an EMPTY (but not locked) password — mirrors `passwd -d pi`.
RUN adduser -D -s /bin/sh pi \
    && passwd -d pi \
    && mkdir -p /home/pi/.ssh && chown -R pi:pi /home/pi

RUN ssh-keygen -A

RUN printf '%s\n' \
    'PasswordAuthentication yes' \
    'PermitEmptyPasswords yes' \
    'PermitRootLogin no' \
    'Subsystem sftp internal-sftp' \
    >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
