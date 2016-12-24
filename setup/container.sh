#!/bin/bash

set -eu -o pipefail

# This file can be used in Dockerfile

readonly USER=yellowtent

readonly USER_DATA_FILE="/root/user_data.img"
readonly USER_DATA_DIR="/home/yellowtent/data"

readonly container_files="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/container"

readonly CONFIG_DIR="/home/yellowtent/configs"
readonly DATA_DIR="/home/yellowtent/data"
readonly provider="${1:-generic}"

usermod "${USER}" -a -G docker

echo "=== Setting up firewall ==="
iptables -t filter -N CLOUDRON || true
iptables -t filter -F CLOUDRON # empty any existing rules

# NOTE: keep these in sync with src/apps.js validatePortBindings
# allow ssh, http, https, ping, dns
iptables -t filter -I CLOUDRON -m state --state RELATED,ESTABLISHED -j ACCEPT
# caas has ssh on port 202
if [[ "${provider}" == "caas" ]]; then
    iptables -A CLOUDRON -p tcp -m tcp -m multiport --dports 25,80,202,443,587,993,4190 -j ACCEPT
else
    iptables -A CLOUDRON -p tcp -m tcp -m multiport --dports 25,80,22,443,587,993,4190 -j ACCEPT
fi
iptables -t filter -A CLOUDRON -p icmp --icmp-type echo-request -j ACCEPT
iptables -t filter -A CLOUDRON -p icmp --icmp-type echo-reply -j ACCEPT
iptables -t filter -A CLOUDRON -p udp --sport 53 -j ACCEPT
iptables -t filter -A CLOUDRON -s 172.18.0.0/16 -j ACCEPT # required to accept any connections from apps to our IP:<public port>
iptables -t filter -A CLOUDRON -i lo -j ACCEPT # required for localhost connections (mysql)

# log dropped incoming. keep this at the end of all the rules
iptables -t filter -A CLOUDRON -m limit --limit 2/min -j LOG --log-prefix "IPTables Packet Dropped: " --log-level 7
iptables -t filter -A CLOUDRON -j DROP

if ! iptables -t filter -C INPUT -j CLOUDRON 2>/dev/null; then
    iptables -t filter -I INPUT -j CLOUDRON
fi

# so it gets restored across reboot
mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4

# make docker use the internal unbound dns server
sed -e 's,^ExecStart=.*$,ExecStart=/usr/bin/docker daemon -H fd:// --log-driver=journald --exec-opt native.cgroupdriver=cgroupfs,' -i /lib/systemd/system/docker.service

# caas has ssh on port 202 and we disable password login
if [[ "${provider}" == "caas" ]]; then
    # https://stackoverflow.com/questions/4348166/using-with-sed on why ? must be escaped
    sed -e 's/^#\?PermitRootLogin .*/PermitRootLogin without-password/g' \
        -e 's/^#\?PermitEmptyPasswords .*/PermitEmptyPasswords no/g' \
        -e 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/g' \
        -e 's/^#\?Port .*/Port 202/g' \
        -i /etc/ssh/sshd_config

    # required so we can connect to this machine since port 22 is blocked by iptables by now
    systemctl reload sshd
fi

echo "=== Setup btrfs data ==="
if ! grep -q loop.ko /lib/modules/`uname -r`/modules.builtin; then
    # on scaleway loop is not built-in
    echo "loop" >> /etc/modules
    modprobe loop
fi

if [[ ! -d "${USER_DATA_DIR}" ]]; then
    truncate -s "8192m" "${USER_DATA_FILE}" # 8gb start (this will get resized dynamically by cloudron-system-setup.service)
    mkfs.btrfs -L UserDataHome "${USER_DATA_FILE}"
    mkdir -p "${USER_DATA_DIR}"
    mount -t btrfs -o loop,nosuid "${USER_DATA_FILE}" ${USER_DATA_DIR}
fi

# Configure time
sed -e 's/^#NTP=/NTP=0.ubuntu.pool.ntp.org 1.ubuntu.pool.ntp.org 2.ubuntu.pool.ntp.org 3.ubuntu.pool.ntp.org/' -i /etc/systemd/timesyncd.conf
timedatectl set-ntp 1
timedatectl set-timezone UTC

########## journald
sed -e "s/^#SystemMaxUse=.*$/SystemMaxUse=100M/" \
    -e "s/^#ForwardToSyslog=.*$/ForwardToSyslog=no/" \
    -i /etc/systemd/journald.conf

# When rotating logs, systemd kills journald too soon sometimes
# See https://github.com/systemd/systemd/issues/1353 (this is upstream default)
sed -e "s/^WatchdogSec=.*$/WatchdogSec=3min/" \
    -i /lib/systemd/system/systemd-journald.service

# Give user access to system logs
usermod -a -G systemd-journal ${USER}
mkdir -p /var/log/journal  # in some images, this directory is not created making system log to /run/systemd instead
chown root:systemd-journal /var/log/journal
systemctl restart systemd-journald
setfacl -n -m u:${USER}:r /var/log/journal/*/system.journal

########## create config directory
rm -rf "${CONFIG_DIR}"
sudo -u yellowtent mkdir "${CONFIG_DIR}"

########## systemd
rm -f /etc/systemd/system/janitor.*
cp -r "${container_files}/systemd/." /etc/systemd/system/
systemctl daemon-reload
systemctl enable cloudron.target
systemctl enable iptables-restore
systemctl enable cloudron-system-setup
systemctl enable docker
systemctl restart docker

########## sudoers
rm -f /etc/sudoers.d/yellowtent
cp "${container_files}/sudoers" /etc/sudoers.d/yellowtent

########## collectd
rm -rf /etc/collectd
ln -sfF "${DATA_DIR}/collectd" /etc/collectd

########## apparmor docker profile
cp "${container_files}/docker-cloudron-app.apparmor" /etc/apparmor.d/docker-cloudron-app
systemctl restart apparmor

########## nginx
# link nginx config to system config
unlink /etc/nginx 2>/dev/null || rm -rf /etc/nginx
ln -s "${DATA_DIR}/nginx" /etc/nginx

########## mysql
cp "${container_files}/mysql.cnf" /etc/mysql/mysql.cnf

########## Enable services
update-rc.d -f collectd defaults

