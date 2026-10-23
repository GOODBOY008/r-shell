# Fixture for the password-auth docker e2e tests in src/ssh/tests.rs:
# docker_ssh_resize_propagates_to_remote_shell,
# docker_ssh_reports_cwd_and_lists_sftp_directories, and
# docker_ssh_tunnel_connects_terminal_and_sftp_through_jump_host.
#
# The tests authenticate as testuser/testpass and drive a PTY whose OSC 7
# cwd reporting relies on r-shell's own PROMPT_COMMAND injection — so the
# login shell must be bash (BusyBox ash has no PROMPT_COMMAND).
#
# /srv/release files/ is the deliberately awkward tree the cwd test walks:
# spaces in the directory name plus a non-ASCII nested directory and file,
# exercising URL-escaping in the OSC 7 report and name handling in SFTP
# listings. Owned by testuser so `cd` into it works.
#
# Build & run:
#   docker build -t rshell-password-sshd src-tauri/docker/password-sshd
#   docker run -d --name rshell-sshd-password -p 2225:22 rshell-password-sshd
FROM alpine:3.19

RUN apk add --no-cache openssh bash shadow

# Password user with a bash login shell.
RUN adduser -D -s /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd

# Awkward-path fixture data for the cwd/SFTP test.
RUN mkdir -p '/srv/release files/子目录' \
    && echo 'report body' > '/srv/release files/子目录/report 1.txt' \
    && chown -R testuser:testuser /srv

RUN ssh-keygen -A

# The jump-host tunnel test opens direct-tcpip channels through this server,
# and Alpine's stock sshd_config hardens them off (AllowTcpForwarding no).
# OpenSSH uses the first occurrence of a keyword, so the stock line must be
# rewritten, not appended after.
RUN sed -i 's/^[[:space:]]*AllowTcpForwarding[[:space:]][[:space:]]*no.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config

RUN printf '%s\n' \
    'PasswordAuthentication yes' \
    'PubkeyAuthentication yes' \
    'PermitRootLogin no' \
    'Subsystem sftp internal-sftp' \
    >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
