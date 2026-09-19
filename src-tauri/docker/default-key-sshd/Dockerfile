# Fixture for the default-keypath integration test in src/ssh/tests.rs
# (issue #103). An Alpine OpenSSH server whose user 'testuser' authenticates
# ONLY with the committed E2E test keypair (id_rsa / id_rsa.pub in this
# directory). The client side of the test points $HOME at a temp dir holding
# the same private key as ~/.ssh/id_rsa and connects with an EMPTY key path —
# the exact flow of "create a connection with publickey auth and no key path".
#
# The keypair here is a throwaway E2E fixture — never use it anywhere real.
#
# Build & run:
#   docker build -t rshell-default-key-sshd src-tauri/docker/default-key-sshd
#   docker run -d --name rshell-sshd-default-key -p 2224:22 rshell-default-key-sshd
#
# Expose the public key: id_rsa.pub is copied so admins can rebuild the
# fixture with a fresh keypair by replacing both files.
FROM alpine:3.19

RUN apk add --no-cache openssh shadow

# User 'testuser'. The password is random and unused — sshd runs with
# PasswordAuthentication no, so publickey is the only path. (passwd -l would
# lock the account entirely, which Alpine sshd rejects preauth.)
RUN adduser -D -s /bin/sh testuser \
    && echo 'testuser:r-shell-e2e-unused-password' | chpasswd \
    && mkdir -p /home/testuser/.ssh && chown -R testuser:testuser /home/testuser

COPY id_rsa.pub /home/testuser/.ssh/authorized_keys
RUN chown testuser:testuser /home/testuser/.ssh/authorized_keys \
    && chmod 600 /home/testuser/.ssh/authorized_keys

RUN ssh-keygen -A

RUN printf '%s\n' \
    'PasswordAuthentication no' \
    'PubkeyAuthentication yes' \
    'PermitRootLogin no' \
    'Subsystem sftp internal-sftp' \
    >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]