# Local SSH fixture for the Docker Monitor dashboard. Bind SSH to loopback only.
FROM docker:29-cli
RUN apk add --no-cache openssh bash shadow \
    && adduser -D -s /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && ssh-keygen -A \
    && printf '%s\n' 'PasswordAuthentication yes' 'PermitRootLogin no' >> /etc/ssh/sshd_config
COPY start.sh /start.sh
ENTRYPOINT ["sh", "/start.sh"]
