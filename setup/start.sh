#!/bin/bash

set -eu -o pipefail

echo "==> Cloudron Start"

readonly USER="yellowtent"
readonly HOME_DIR="/home/${USER}"
readonly BOX_SRC_DIR="${HOME_DIR}/box"
readonly PLATFORM_DATA_DIR="${HOME_DIR}/platformdata" # platform data
readonly APPS_DATA_DIR="${HOME_DIR}/appsdata" # app data
readonly BOX_DATA_DIR="${HOME_DIR}/boxdata" # box data
readonly CONFIG_DIR="${HOME_DIR}/configs"

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "${script_dir}/argparser.sh" "$@" # this injects the arg_* variables used below

echo "==> Configuring docker"
cp "${script_dir}/start/docker-cloudron-app.apparmor" /etc/apparmor.d/docker-cloudron-app
systemctl enable apparmor
systemctl restart apparmor

usermod ${USER} -a -G docker
# preserve the existing storage driver (user might be using overlay2)
storage_driver=$(docker info | grep "Storage Driver" | sed 's/.*: //')
[[ -n "${storage_driver}" ]] || storage_driver="overlay2" # if the above command fails

temp_file=$(mktemp)
# create systemd drop-in. some apps do not work with aufs
echo -e "[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// --log-driver=journald --exec-opt native.cgroupdriver=cgroupfs --storage-driver=${storage_driver}" > "${temp_file}"

systemctl enable docker
# restart docker if options changed
if [[ ! -f /etc/systemd/system/docker.service.d/cloudron.conf ]] || ! diff -q /etc/systemd/system/docker.service.d/cloudron.conf "${temp_file}" >/dev/null; then
    mkdir -p /etc/systemd/system/docker.service.d
    mv "${temp_file}" /etc/systemd/system/docker.service.d/cloudron.conf
    systemctl daemon-reload
    systemctl restart docker
fi
docker network create --subnet=172.18.0.0/16 cloudron || true

# caas has ssh on port 202 and we disable password login
if [[ "${arg_provider}" == "caas" ]]; then
    # https://stackoverflow.com/questions/4348166/using-with-sed on why ? must be escaped
    sed -e 's/^#\?PermitRootLogin .*/PermitRootLogin without-password/g' \
        -e 's/^#\?PermitEmptyPasswords .*/PermitEmptyPasswords no/g' \
        -e 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/g' \
        -e 's/^#\?Port .*/Port 202/g' \
        -i /etc/ssh/sshd_config

    # required so we can connect to this machine since port 22 is blocked by iptables by now
    systemctl reload sshd
fi

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
mkdir -p "${PLATFORM_DATA_DIR}/logs/backup"
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

echo "==> Creating config directory"
mkdir -p "${CONFIG_DIR}"

echo "==> Setting up unbound"
# DO uses Google nameservers by default. This causes RBL queries to fail (host 2.0.0.127.zen.spamhaus.org)
# We do not use dnsmasq because it is not a recursive resolver and defaults to the value in the interfaces file (which is Google DNS!)
# We listen on 0.0.0.0 because there is no way control ordering of docker (which creates the 172.18.0.0/16) and unbound
# If IP6 is not enabled, dns queries seem to fail on some hosts
echo -e "server:\n\tinterface: 0.0.0.0\n\tdo-ip6: yes\n\taccess-control: 127.0.0.1 allow\n\taccess-control: 172.18.0.1/16 allow\n\tcache-max-negative-ttl: 30\n\tcache-max-ttl: 300\n\t#logfile: /var/log/unbound.log\n\t#verbosity: 10" > /etc/unbound/unbound.conf.d/cloudron-network.conf
# update the root anchor after a out-of-disk-space situation (see #269)
unbound-anchor -a /var/lib/unbound/root.key

echo "==> Adding systemd services"
cp -r "${script_dir}/start/systemd/." /etc/systemd/system/
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
cp "${script_dir}/start/app-logrotate" "${PLATFORM_DATA_DIR}/logrotate.d/app-logrotate"
chown root:root "${PLATFORM_DATA_DIR}/logrotate.d/app-logrotate"

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

# bookkeep the version as part of data
echo "{ \"version\": \"${arg_version}\", \"apiServerOrigin\": \"${arg_api_server_origin}\" }" > "${BOX_DATA_DIR}/version"

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
sudo -u "${USER}" -H bash <<EOF
set -eu
cd "${BOX_SRC_DIR}"
BOX_ENV=cloudron DATABASE_URL=mysql://root:${mysql_root_password}@127.0.0.1/box "${BOX_SRC_DIR}/node_modules/.bin/db-migrate" up
EOF

echo "==> Creating cloudron.conf"
cat > "${CONFIG_DIR}/cloudron.conf" <<CONF_END
{
    "version": "${arg_version}",
    "apiServerOrigin": "${arg_api_server_origin}",
    "webServerOrigin": "${arg_web_server_origin}",
    "adminDomain": "${arg_admin_domain}",
    "adminFqdn": "${arg_admin_fqdn}",
    "adminLocation": "${arg_admin_location}",
    "provider": "${arg_provider}",
    "isDemo": ${arg_is_demo},
    "edition": "${arg_edition}"
}
CONF_END

echo "==> Creating config.json for dashboard"
cat > "${BOX_SRC_DIR}/dashboard/dist/config.json" <<CONF_END
{
    "webServerOrigin": "${arg_web_server_origin}"
}
CONF_END

if [[ ! -f "${BOX_DATA_DIR}/dhparams.pem" ]]; then
    echo "==> Generating dhparams (takes forever)"
    openssl dhparam -out "${BOX_DATA_DIR}/dhparams.pem" 2048
    cp "${BOX_DATA_DIR}/dhparams.pem" "${PLATFORM_DATA_DIR}/addons/mail/dhparams.pem"
else
    cp "${BOX_DATA_DIR}/dhparams.pem" "${PLATFORM_DATA_DIR}/addons/mail/dhparams.pem"
fi

echo "==> Changing ownership"
chown "${USER}:${USER}" -R "${CONFIG_DIR}"
chown "${USER}:${USER}" -R "${PLATFORM_DATA_DIR}/nginx" "${PLATFORM_DATA_DIR}/collectd" "${PLATFORM_DATA_DIR}/addons" "${PLATFORM_DATA_DIR}/acme" "${PLATFORM_DATA_DIR}/backup" "${PLATFORM_DATA_DIR}/logs" "${PLATFORM_DATA_DIR}/update" "${PLATFORM_DATA_DIR}/redis"
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
