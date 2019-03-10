#!/bin/bash

set -eu -o pipefail

# This script is run after the box code is switched. This means that this script
# should pretty much always succeed. No network logic/download code here.

echo "==> Cloudron Start"

readonly USER="yellowtent"
readonly HOME_DIR="/home/${USER}"
readonly BOX_SRC_DIR="${HOME_DIR}/box"
readonly PLATFORM_DATA_DIR="${HOME_DIR}/platformdata" # platform data
readonly APPS_DATA_DIR="${HOME_DIR}/appsdata" # app data
readonly BOX_DATA_DIR="${HOME_DIR}/boxdata" # box data

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly json="$(realpath ${script_dir}/../node_modules/.bin/json)"
readonly ubuntu_version=$(lsb_release -rs)

cp -f "${script_dir}/../scripts/cloudron-support" /usr/bin/cloudron-support

echo "==> Configuring docker"
cp "${script_dir}/start/docker-cloudron-app.apparmor" /etc/apparmor.d/docker-cloudron-app
systemctl enable apparmor
systemctl restart apparmor

usermod ${USER} -a -G docker
docker network create --subnet=172.18.0.0/16 cloudron || true

mkdir -p "${BOX_DATA_DIR}"
mkdir -p "${APPS_DATA_DIR}"

# keep these in sync with paths.js
echo "==> Ensuring directories"

mkdir -p "${PLATFORM_DATA_DIR}/graphite"
mkdir -p "${PLATFORM_DATA_DIR}/mysql"
mkdir -p "${PLATFORM_DATA_DIR}/postgresql"
mkdir -p "${PLATFORM_DATA_DIR}/mongodb"
mkdir -p "${PLATFORM_DATA_DIR}/redis"
mkdir -p "${PLATFORM_DATA_DIR}/addons/mail"
mkdir -p "${PLATFORM_DATA_DIR}/collectd/collectd.conf.d"
mkdir -p "${PLATFORM_DATA_DIR}/logrotate.d"
mkdir -p "${PLATFORM_DATA_DIR}/acme"
mkdir -p "${PLATFORM_DATA_DIR}/backup"
mkdir -p "${PLATFORM_DATA_DIR}/logs/backup" \
         "${PLATFORM_DATA_DIR}/logs/updater" \
         "${PLATFORM_DATA_DIR}/logs/tasks" \
         "${PLATFORM_DATA_DIR}/logs/crash"
mkdir -p "${PLATFORM_DATA_DIR}/update"

mkdir -p "${BOX_DATA_DIR}/appicons"
mkdir -p "${BOX_DATA_DIR}/certs"
mkdir -p "${BOX_DATA_DIR}/acme" # acme keys
mkdir -p "${BOX_DATA_DIR}/mail/dkim"

# ensure backups folder exists and is writeable
mkdir -p /var/backups
chmod 777 /var/backups

echo "==> Configuring journald"
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
systemctl daemon-reload
systemctl restart systemd-journald
setfacl -n -m u:${USER}:r /var/log/journal/*/system.journal

echo "==> Setting up unbound"
# DO uses Google nameservers by default. This causes RBL queries to fail (host 2.0.0.127.zen.spamhaus.org)
# We do not use dnsmasq because it is not a recursive resolver and defaults to the value in the interfaces file (which is Google DNS!)
# We listen on 0.0.0.0 because there is no way control ordering of docker (which creates the 172.18.0.0/16) and unbound
# If IP6 is not enabled, dns queries seem to fail on some hosts. -s returns false if file missing or 0 size
ip6=$([[ -s /proc/net/if_inet6 ]] && echo "yes" || echo "no")
echo -e "server:\n\tinterface: 0.0.0.0\n\tdo-ip6: ${ip6}\n\taccess-control: 127.0.0.1 allow\n\taccess-control: 172.18.0.1/16 allow\n\tcache-max-negative-ttl: 30\n\tcache-max-ttl: 300\n\t#logfile: /var/log/unbound.log\n\t#verbosity: 10" > /etc/unbound/unbound.conf.d/cloudron-network.conf
# update the root anchor after a out-of-disk-space situation (see #269)
unbound-anchor -a /var/lib/unbound/root.key

echo "==> Adding systemd services"
cp -r "${script_dir}/start/systemd/." /etc/systemd/system/
[[ "${ubuntu_version}" == "16.04" ]] && sed -e 's/MemoryMax/MemoryLimit/g' -i /etc/systemd/system/box.service
systemctl daemon-reload
systemctl enable unbound
systemctl enable cloudron-syslog
systemctl enable cloudron.target
systemctl enable cloudron-firewall

# update firewall rules
systemctl restart cloudron-firewall

# For logrotate
systemctl enable --now cron

# ensure unbound runs
systemctl restart unbound

# ensure cloudron-syslog runs
systemctl restart cloudron-syslog

$json -f /etc/cloudron/cloudron.conf -I -e "delete this.adminLocation" # can be removed after 3.6

echo "==> Configuring sudoers"
rm -f /etc/sudoers.d/${USER}
cp "${script_dir}/start/sudoers" /etc/sudoers.d/${USER}

echo "==> Configuring collectd"
rm -rf /etc/collectd
ln -sfF "${PLATFORM_DATA_DIR}/collectd" /etc/collectd
cp "${script_dir}/start/collectd/collectd.conf" "${PLATFORM_DATA_DIR}/collectd/collectd.conf"
systemctl restart collectd

echo "==> Configuring logrotate"
if ! grep -q "^include ${PLATFORM_DATA_DIR}/logrotate.d" /etc/logrotate.conf; then
    echo -e "\ninclude ${PLATFORM_DATA_DIR}/logrotate.d\n" >> /etc/logrotate.conf
fi
cp "${script_dir}/start/logrotate/"* "${PLATFORM_DATA_DIR}/logrotate.d/"
rm -f "${PLATFORM_DATA_DIR}/logrotate.d/box-logrotate" "${PLATFORM_DATA_DIR}/logrotate.d/app-logrotate" # remove pre 3.6 config files
chown root:root "${PLATFORM_DATA_DIR}/logrotate.d/"

echo "==> Adding motd message for admins"
cp "${script_dir}/start/cloudron-motd" /etc/update-motd.d/92-cloudron

echo "==> Configuring nginx"
# link nginx config to system config
unlink /etc/nginx 2>/dev/null || rm -rf /etc/nginx
ln -s "${PLATFORM_DATA_DIR}/nginx" /etc/nginx
mkdir -p "${PLATFORM_DATA_DIR}/nginx/applications"
mkdir -p "${PLATFORM_DATA_DIR}/nginx/cert"
cp "${script_dir}/start/nginx/nginx.conf" "${PLATFORM_DATA_DIR}/nginx/nginx.conf"
cp "${script_dir}/start/nginx/mime.types" "${PLATFORM_DATA_DIR}/nginx/mime.types"
if ! grep -q "^Restart=" /etc/systemd/system/multi-user.target.wants/nginx.service; then
    # default nginx service file does not restart on crash
    echo -e "\n[Service]\nRestart=always\n" >> /etc/systemd/system/multi-user.target.wants/nginx.service
    systemctl daemon-reload
fi
systemctl start nginx

# restart mysql to make sure it has latest config
if [[ ! -f /etc/mysql/mysql.cnf ]] || ! diff -q "${script_dir}/start/mysql.cnf" /etc/mysql/mysql.cnf >/dev/null; then
    # wait for all running mysql jobs
    cp "${script_dir}/start/mysql.cnf" /etc/mysql/mysql.cnf
    while true; do
        if ! systemctl list-jobs | grep mysql; then break; fi
        echo "Waiting for mysql jobs..."
        sleep 1
    done
    while true; do
        if systemctl restart mysql; then break; fi
        echo "Restarting MySql again after sometime since this fails randomly"
        sleep 1
    done
else
    systemctl start mysql
fi

readonly mysql_root_password="password"
mysqladmin -u root -ppassword password password # reset default root password
mysql -u root -p${mysql_root_password} -e 'CREATE DATABASE IF NOT EXISTS box'

echo "==> Migrating data"
(cd "${BOX_SRC_DIR}" && BOX_ENV=cloudron DATABASE_URL=mysql://root:${mysql_root_password}@127.0.0.1/box "${BOX_SRC_DIR}/node_modules/.bin/db-migrate" up)

if [[ ! -f "${BOX_DATA_DIR}/dhparams.pem" ]]; then
    echo "==> Generating dhparams (takes forever)"
    openssl dhparam -out "${BOX_DATA_DIR}/dhparams.pem" 2048
    cp "${BOX_DATA_DIR}/dhparams.pem" "${PLATFORM_DATA_DIR}/addons/mail/dhparams.pem"
else
    cp "${BOX_DATA_DIR}/dhparams.pem" "${PLATFORM_DATA_DIR}/addons/mail/dhparams.pem"
fi

echo "==> Changing ownership"
# be careful of what is chown'ed here. subdirs like mysql,redis etc are owned by the containers and will stop working if perms change
chown -R "${USER}" /etc/cloudron
chown "${USER}:${USER}" -R "${PLATFORM_DATA_DIR}/nginx" "${PLATFORM_DATA_DIR}/collectd" "${PLATFORM_DATA_DIR}/addons" "${PLATFORM_DATA_DIR}/acme" "${PLATFORM_DATA_DIR}/backup" "${PLATFORM_DATA_DIR}/logs" "${PLATFORM_DATA_DIR}/update"
chown "${USER}:${USER}" "${PLATFORM_DATA_DIR}/INFRA_VERSION" 2>/dev/null || true
chown "${USER}:${USER}" "${PLATFORM_DATA_DIR}"
chown "${USER}:${USER}" "${APPS_DATA_DIR}"

# logrotate files have to be owned by root, this is here to fixup existing installations where we were resetting the owner to yellowtent
chown root:root -R "${PLATFORM_DATA_DIR}/logrotate.d"

# do not chown the boxdata/mail directory; dovecot gets upset
chown "${USER}:${USER}" "${BOX_DATA_DIR}"
find "${BOX_DATA_DIR}" -mindepth 1 -maxdepth 1 -not -path "${BOX_DATA_DIR}/mail" -exec chown -R "${USER}:${USER}" {} \;
chown "${USER}:${USER}" "${BOX_DATA_DIR}/mail"
chown "${USER}:${USER}" -R "${BOX_DATA_DIR}/mail/dkim" # this is owned by box currently since it generates the keys

echo "==> Starting Cloudron"
systemctl start cloudron.target

sleep 2 # give systemd sometime to start the processes

echo "==> Almost done"
