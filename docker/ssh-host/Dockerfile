# SSH target for the integration tests.
#
# Runs sshd with the database client tools installed, so a source configured
# for SSH mode executes its dump and restore commands here rather than in the
# test process. From this container the database services in
# docker-compose.test.yml are reachable by their service name, which is exactly
# the topology SSH mode exists for: the database port never has to be published
# to the machine running DBackup.
#
# Client versions are chosen against the *oldest* server in the matrix, since a
# dump tool refuses to read a newer server than itself. Debian 12 ships
# postgresql-client 15 (fine against postgres-12) and mariadb-client 10.11.
FROM debian:12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server \
        openssh-client \
        mariadb-client \
        postgresql-client \
        redis-tools \
        sqlite3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Key-only authentication. Debian's default already refuses passwords for root,
# but stating it explicitly keeps the container honest if the base image changes.
RUN mkdir -p /run/sshd /root/.ssh /etc/ssh/sshd_config.d \
    && chmod 700 /root/.ssh \
    && printf '%s\n' \
        'PermitRootLogin prohibit-password' \
        'PasswordAuthentication no' \
        'KbdInteractiveAuthentication no' \
        > /etc/ssh/sshd_config.d/10-dbackup-test.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
