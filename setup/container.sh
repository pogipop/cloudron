#!/bin/bash

set -eu -o pipefail

# This file can be used in Dockerfile

readonly USER=yellowtent

readonly container_files="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/container"

readonly CONFIG_DIR="/home/yellowtent/configs"
readonly DATA_DIR="/home/yellowtent/data"

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

