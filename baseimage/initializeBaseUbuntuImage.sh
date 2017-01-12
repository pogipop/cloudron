#!/bin/bash

set -euv -o pipefail

readonly SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

readonly arg_provider="${1:-generic}"
readonly arg_infraversionpath="${SOURCE_DIR}/${2:-}"

function die {
    echo $1
    exit 1
}

export DEBIAN_FRONTEND=noninteractive

apt-get -o Dpkg::Options::="--force-confdef" update -y
apt-get -o Dpkg::Options::="--force-confdef" dist-upgrade -y

# https://docs.docker.com/engine/installation/linux/ubuntulinux/
echo "==> Installing Docker"
apt-key adv --keyserver hkp://ha.pool.sks-keyservers.net:80 --recv-keys 58118E89F3A912897C070ADBF76221572C52609D
echo "deb https://apt.dockerproject.org/repo ubuntu-xenial main" > /etc/apt/sources.list.d/docker.list
apt-get -y update
apt-get -y install \
    aufs-tools \
    linux-image-extra-$(uname -r) \
    linux-image-extra-virtual \
    docker-engine=1.12.5-0~ubuntu-xenial # apt-cache madison docker-engine

echo "==> Enable memory accounting"
sed -e 's/^GRUB_CMDLINE_LINUX="\(.*\)"$/GRUB_CMDLINE_LINUX="\1 cgroup_enable=memory swapaccount=1 panic_on_oops=1 panic=5"/' -i /etc/default/grub
update-grub

echo "==> Installing required packages"

debconf-set-selections <<< 'mysql-server mysql-server/root_password password password'
debconf-set-selections <<< 'mysql-server mysql-server/root_password_again password password'

# this enables automatic security upgrades (https://help.ubuntu.com/community/AutomaticSecurityUpdates)
apt-get -y install \
    acl \
    awscli \
    btrfs-tools \
    build-essential \
    cron \
    curl \
    iptables \
    logrotate \
    mysql-server-5.7 \
    nginx-full \
    openssh-server \
    pwgen \
    rcconf \
    swaks \
    unattended-upgrades \
    unbound

echo "==> Installing node.js"
mkdir -p /usr/local/node-6.9.2
curl -sL https://nodejs.org/dist/v6.9.2/node-v6.9.2-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-6.9.2
ln -sf /usr/local/node-6.9.2/bin/node /usr/bin/node
ln -sf /usr/local/node-6.9.2/bin/npm /usr/bin/npm
apt-get install -y python   # Install python which is required for npm rebuild
[[ "$(python --version 2>&1)" == "Python 2.7."* ]] || die "Expecting python version to be 2.7.x"

echo "==> Downloading docker images"
if [ ! -f "${arg_infraversionpath}/infra_version.js" ]; then
    echo "No infra_versions.js found"
    exit 1
fi

images=$(node -e "var i = require('${arg_infraversionpath}/infra_version.js'); console.log(i.baseImages.join(' '), Object.keys(i.images).map(function (x) { return i.images[x].tag; }).join(' '));")

echo -e "\tPulling docker images: ${images}"
for image in ${images}; do
    docker pull "${image}"
done

echo "==> Install collectd"
if ! apt-get install -y collectd collectd-utils; then
    # FQDNLookup is true in default debian config. The box code has a custom collectd.conf that fixes this
    echo "Failed to install collectd. Presumably because of http://mailman.verplant.org/pipermail/collectd/2015-March/006491.html"
    sed -e 's/^FQDNLookup true/FQDNLookup false/' -i /etc/collectd/collectd.conf
fi

