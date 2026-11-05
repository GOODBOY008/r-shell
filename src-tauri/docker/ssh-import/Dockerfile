FROM alpine:3.21
RUN apk add --no-cache openssh bash shadow
RUN for user in jumpone jumptwo target; do adduser -D -s /bin/bash "$user" && echo "$user:unused-fixture-password" | chpasswd; done
COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
