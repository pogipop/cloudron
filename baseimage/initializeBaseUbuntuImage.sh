#!/bin/bash

set -euv -o pipefail

readonly USER=yellowtent
readonly USER_HOME="/home/${USER}"
readonly INSTALLER_SOURCE_DIR="${USER_HOME}/installer"
readonly INSTALLER_REVISION="${1:-master}"
readonly PROVIDER="${2:-generic}"

readonly SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

function die {
    echo $1
    exit 1
}

[[ "$(systemd --version 2>&1)" == *"systemd 229"* ]] || die "Expecting systemd to be 229"

echo "==== Create User ${USER} ===="
if ! id "${USER}"; then
    useradd "${USER}" -m
fi

export DEBIAN_FRONTEND=noninteractive

echo "=== Upgrade ==="
apt-get -o Dpkg::Options::="--force-confdef" update -y
apt-get -o Dpkg::Options::="--force-confdef" dist-upgrade -y
apt-get install -y curl iptables

echo "==== Install btrfs tools ==="
apt-get -y install btrfs-tools

# https://docs.docker.com/engine/installation/linux/ubuntulinux/
echo "==== Install docker ===="
apt-key adv --keyserver hkp://ha.pool.sks-keyservers.net:80 --recv-keys 58118E89F3A912897C070ADBF76221572C52609D
echo "deb https://apt.dockerproject.org/repo ubuntu-xenial main" > /etc/apt/sources.list.d/docker.list
apt-get -y update
apt-get -y install aufs-tools linux-image-extra-$(uname -r) linux-image-extra-virtual
apt-get -y install docker-engine=1.12.5-0~ubuntu-xenial # apt-cache madison docker-engine
usermod "${USER}" -a -G docker

echo "=== Enable memory accounting =="
sed -e 's/^GRUB_CMDLINE_LINUX="\(.*\)"$/GRUB_CMDLINE_LINUX="\1 cgroup_enable=memory swapaccount=1 panic_on_oops=1 panic=5"/' -i /etc/default/grub
update-grub

echo "==== Install nodejs ===="
mkdir -p /usr/local/node-6.9.2
curl -sL https://nodejs.org/dist/v6.9.2/node-v6.9.2-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-6.9.2
ln -s /usr/local/node-6.9.2/bin/node /usr/bin/node
ln -s /usr/local/node-6.9.2/bin/npm /usr/bin/npm
apt-get install -y python   # Install python which is required for npm rebuild
[[ "$(python --version 2>&1)" == "Python 2.7."* ]] || die "Expecting python version to be 2.7.x"

echo "==== Downloading docker images ===="
if [ -f ${SOURCE_DIR}/infra_version.js ]; then
    images=$(node -e "var i = require('${SOURCE_DIR}/infra_version.js'); console.log(i.baseImages.join(' '), Object.keys(i.images).map(function (x) { return i.images[x].tag; }).join(' '));")

    echo "Pulling images: ${images}"
    for image in ${images}; do
        docker pull "${image}"
    done
else
    echo "No infra_versions.js found, skipping image download"
fi

echo "==== Install nginx ===="
apt-get -y install nginx-full
[[ "$(nginx -v 2>&1)" == *"nginx/1.10."* ]] || die "Expecting nginx version to be 1.10.x"

echo "==== Install build-essential ===="
apt-get -y install build-essential rcconf

echo "==== Install mysql ===="
debconf-set-selections <<< 'mysql-server mysql-server/root_password password password'
debconf-set-selections <<< 'mysql-server mysql-server/root_password_again password password'
apt-get -y install mysql-server-5.7
[[ "$(mysqld --version 2>&1)" == *"5.7."* ]] || die "Expecting mysql version to be 5.7.x"

echo "==== Install pwgen and swaks awscli ===="
apt-get -y install pwgen swaks awscli

echo "==== Install collectd ==="
if ! apt-get install -y collectd collectd-utils; then
    # FQDNLookup is true in default debian config. The box code has a custom collectd.conf that fixes this
    echo "Failed to install collectd. Presumably because of http://mailman.verplant.org/pipermail/collectd/2015-March/006491.html"
    sed -e 's/^FQDNLookup true/FQDNLookup false/' -i /etc/collectd/collectd.conf
fi
update-rc.d -f collectd remove

# this simply makes it explicit that we run logrotate via cron. it's already part of base ubuntu
echo "==== Install logrotate ==="
apt-get install -y cron logrotate
systemctl enable cron

echo "=== Prepare installer revision - ${INSTALLER_REVISION}) ==="
rm -rf /tmp/box && mkdir -p /tmp/box
curl "https://git.cloudron.io/cloudron/box/repository/archive.tar.gz?ref=${INSTALLER_REVISION}" | tar zxvf - --strip-components=1 -C /tmp/box
mkdir -p "${INSTALLER_SOURCE_DIR}"
cp -rf /tmp/box/installer/* "${INSTALLER_SOURCE_DIR}" && rm -rf /tmp/box
chown "${USER}:${USER}" -R "${INSTALLER_SOURCE_DIR}"
echo "${INSTALLER_REVISION}" > "${INSTALLER_SOURCE_DIR}/REVISION"

apt-get -y install acl

# DO uses Google nameservers by default. This causes RBL queries to fail (host 2.0.0.127.zen.spamhaus.org)
# We do not use dnsmasq because it is not a recursive resolver and defaults to the value in the interfaces file (which is Google DNS!)
echo "==== Install unbound DNS ==="
apt-get -y install unbound

echo "==== Install ssh ==="
apt-get -y install openssh-server
