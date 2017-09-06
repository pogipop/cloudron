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

echo "==> Installing required packages"

debconf-set-selections <<< 'mysql-server mysql-server/root_password password password'
debconf-set-selections <<< 'mysql-server mysql-server/root_password_again password password'

# this enables automatic security upgrades (https://help.ubuntu.com/community/AutomaticSecurityUpdates)
apt-get -y install \
    acl \
    awscli \
    build-essential \
    cron \
    curl \
    dmsetup \
    iptables \
    logrotate \
    mysql-server-5.7 \
    nginx-full \
    openssh-server \
    pwgen \
    rcconf \
    swaks \
    unattended-upgrades \
    unbound \
    xfsprogs

# this ensures that unattended upgades are enabled, if it was disabled during ubuntu install time (see #346)
# debconf-set-selection of unattended-upgrades/enable_auto_updates + dpkg-reconfigure does not work
cp /usr/share/unattended-upgrades/20auto-upgrades /etc/apt/apt.conf.d/20auto-upgrades

echo "==> Installing node.js"
mkdir -p /usr/local/node-6.11.3
curl -sL https://nodejs.org/dist/v6.11.3/node-v6.11.3-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-6.11.3
ln -sf /usr/local/node-6.11.3/bin/node /usr/bin/node
ln -sf /usr/local/node-6.11.3/bin/npm /usr/bin/npm
apt-get install -y python   # Install python which is required for npm rebuild
[[ "$(python --version 2>&1)" == "Python 2.7."* ]] || die "Expecting python version to be 2.7.x"

# https://docs.docker.com/engine/installation/linux/ubuntulinux/
echo "==> Installing Docker"

# create systemd drop-in file
mkdir -p /etc/systemd/system/docker.service.d
echo -e "[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// --log-driver=journald --exec-opt native.cgroupdriver=cgroupfs --storage-driver=overlay2" > /etc/systemd/system/docker.service.d/cloudron.conf

curl -sL https://download.docker.com/linux/ubuntu/dists/xenial/pool/stable/amd64/docker-ce_17.03.1~ce-0~ubuntu-xenial_amd64.deb -o /tmp/docker.deb
# apt install with install deps (as opposed to dpkg -i)
apt install -y /tmp/docker.deb
rm /tmp/docker.deb

storage_driver=$(docker info | grep "Storage Driver" | sed 's/.*: //')
if [[ "${storage_driver}" != "overlay2" ]]; then
    echo "Docker is using "${storage_driver}" instead of overlay2"
    exit 1
fi

echo "==> Enable memory accounting"
apt-get -y install grub2
sed -e 's/^GRUB_CMDLINE_LINUX="\(.*\)"$/GRUB_CMDLINE_LINUX="\1 cgroup_enable=memory swapaccount=1 panic_on_oops=1 panic=5"/' -i /etc/default/grub
update-grub

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

# Disable bind for good measure (on online.net, kimsufi servers these are pre-installed and conflicts with unbound)
systemctl stop bind9 || true
systemctl disable bind9 || true

# on ovh images dnsmasq seems to run by default
systemctl stop dnsmasq || true
systemctl disable dnsmasq || true

