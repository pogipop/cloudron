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

# hold grub since updating it breaks on some VPS providers. also, dist-upgrade will trigger it
apt-mark hold grub* >/dev/null
apt-get -o Dpkg::Options::="--force-confdef" update -y
apt-get -o Dpkg::Options::="--force-confdef" upgrade -y
apt-mark unhold grub* >/dev/null

echo "==> Installing required packages"

debconf-set-selections <<< 'mysql-server mysql-server/root_password password password'
debconf-set-selections <<< 'mysql-server mysql-server/root_password_again password password'

# this enables automatic security upgrades (https://help.ubuntu.com/community/AutomaticSecurityUpdates)
# resolvconf is needed for unbound to work property after disabling systemd-resolved in 18.04
ubuntu_version=$(lsb_release -rs)
ubuntu_codename=$(lsb_release -cs)
gpg_package=$([[ "${ubuntu_version}" == "16.04" ]] && echo "gnupg" || echo "gpg")
apt-get -y install \
    acl \
    build-essential \
    cron \
    curl \
    dmsetup \
    $gpg_package \
    iptables \
    libpython2.7 \
    logrotate \
    mysql-server-5.7 \
    nginx-full \
    openssh-server \
    pwgen \
    resolvconf \
    sudo \
    swaks \
    unattended-upgrades \
    unbound \
    xfsprogs

# this ensures that unattended upgades are enabled, if it was disabled during ubuntu install time (see #346)
# debconf-set-selection of unattended-upgrades/enable_auto_updates + dpkg-reconfigure does not work
cp /usr/share/unattended-upgrades/20auto-upgrades /etc/apt/apt.conf.d/20auto-upgrades

echo "==> Installing node.js"
mkdir -p /usr/local/node-10.15.1
curl -sL https://nodejs.org/dist/v10.15.1/node-v10.15.1-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-10.15.1
ln -sf /usr/local/node-10.15.1/bin/node /usr/bin/node
ln -sf /usr/local/node-10.15.1/bin/npm /usr/bin/npm
apt-get install -y python   # Install python which is required for npm rebuild
[[ "$(python --version 2>&1)" == "Python 2.7."* ]] || die "Expecting python version to be 2.7.x"

# https://docs.docker.com/engine/installation/linux/ubuntulinux/
echo "==> Installing Docker"

# create systemd drop-in file. if you channge options here, be sure to fixup installer.sh as well
mkdir -p /etc/systemd/system/docker.service.d
echo -e "[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// --log-driver=journald --exec-opt native.cgroupdriver=cgroupfs --storage-driver=overlay2" > /etc/systemd/system/docker.service.d/cloudron.conf

# there are 3 packages for docker - containerd, CLI and the daemon
curl -sL "https://download.docker.com/linux/ubuntu/dists/${ubuntu_codename}/pool/stable/amd64/containerd.io_1.2.2-3_amd64.deb" -o /tmp/containerd.deb
curl -sL "https://download.docker.com/linux/ubuntu/dists/${ubuntu_codename}/pool/stable/amd64/docker-ce-cli_18.09.2~3-0~ubuntu-${ubuntu_codename}_amd64.deb" -o /tmp/docker-ce-cli.deb
curl -sL "https://download.docker.com/linux/ubuntu/dists/${ubuntu_codename}/pool/stable/amd64/docker-ce_18.09.2~3-0~ubuntu-${ubuntu_codename}_amd64.deb" -o /tmp/docker.deb
# apt install with install deps (as opposed to dpkg -i)
apt install -y /tmp/containerd.deb  /tmp/docker-ce-cli.deb /tmp/docker.deb
rm /tmp/containerd.deb /tmp/docker-ce-cli.deb /tmp/docker.deb

storage_driver=$(docker info | grep "Storage Driver" | sed 's/.*: //')
if [[ "${storage_driver}" != "overlay2" ]]; then
    echo "Docker is using "${storage_driver}" instead of overlay2"
    exit 1
fi

# do not upgrade grub because it might prompt user and break this script
echo "==> Enable memory accounting"
apt-get -y --no-upgrade install grub2-common
sed -e 's/^GRUB_CMDLINE_LINUX="\(.*\)"$/GRUB_CMDLINE_LINUX="\1 cgroup_enable=memory swapaccount=1 panic_on_oops=1 panic=5"/' -i /etc/default/grub
update-grub

echo "==> Downloading docker images"
if [ ! -f "${arg_infraversionpath}/infra_version.js" ]; then
    echo "No infra_versions.js found"
    exit 1
fi

images=$(node -e "var i = require('${arg_infraversionpath}/infra_version.js'); console.log(i.baseImages.map(function (x) { return x.tag; }).join(' '), Object.keys(i.images).map(function (x) { return i.images[x].tag; }).join(' '));")

echo -e "\tPulling docker images: ${images}"
for image in ${images}; do
    docker pull "${image}"
    docker pull "${image%@sha256:*}" # this will tag the image for readability
done

echo "==> Install collectd"
if ! apt-get install -y collectd collectd-utils; then
    # FQDNLookup is true in default debian config. The box code has a custom collectd.conf that fixes this
    echo "Failed to install collectd. Presumably because of http://mailman.verplant.org/pipermail/collectd/2015-March/006491.html"
    sed -e 's/^FQDNLookup true/FQDNLookup false/' -i /etc/collectd/collectd.conf
fi

echo "==> Configuring host"
sed -e 's/^#NTP=/NTP=0.ubuntu.pool.ntp.org 1.ubuntu.pool.ntp.org 2.ubuntu.pool.ntp.org 3.ubuntu.pool.ntp.org/' -i /etc/systemd/timesyncd.conf
timedatectl set-ntp 1
timedatectl set-timezone UTC

# Disable bind for good measure (on online.net, kimsufi servers these are pre-installed and conflicts with unbound)
systemctl stop bind9 || true
systemctl disable bind9 || true

# on ovh images dnsmasq seems to run by default
systemctl stop dnsmasq || true
systemctl disable dnsmasq || true

# on ssdnodes postfix seems to run by default
systemctl stop postfix || true
systemctl disable postfix || true

# on ubuntu 18.04, this is the default. this requires resolvconf for DNS to work further after the disable
systemctl stop systemd-resolved || true
systemctl disable systemd-resolved || true

# ubuntu's default config for unbound does not work if ipv6 is disabled. this config is overwritten in start.sh
# we need unbound to work as this is required for installer.sh to do any DNS requests
ip6=$([[ -s /proc/net/if_inet6 ]] && echo "yes" || echo "no")
echo -e "server:\n\tinterface: 127.0.0.1\n\tdo-ip6: ${ip6}" > /etc/unbound/unbound.conf.d/cloudron-network.conf
systemctl restart unbound

