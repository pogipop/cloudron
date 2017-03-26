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
    btrfs-tools \
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
    unbound

echo "==> Installing node.js"
mkdir -p /usr/local/node-6.9.2
curl -sL https://nodejs.org/dist/v6.9.2/node-v6.9.2-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-6.9.2
ln -sf /usr/local/node-6.9.2/bin/node /usr/bin/node
ln -sf /usr/local/node-6.9.2/bin/npm /usr/bin/npm
apt-get install -y python   # Install python which is required for npm rebuild
[[ "$(python --version 2>&1)" == "Python 2.7."* ]] || die "Expecting python version to be 2.7.x"

# https://docs.docker.com/engine/installation/linux/ubuntulinux/
echo "==> Installing Docker"
docker_key="-----BEGIN PGP PUBLIC KEY BLOCK-----
Version: GnuPG v1

mQINBFWln24BEADrBl5p99uKh8+rpvqJ48u4eTtjeXAWbslJotmC/CakbNSqOb9o
ddfzRvGVeJVERt/Q/mlvEqgnyTQy+e6oEYN2Y2kqXceUhXagThnqCoxcEJ3+KM4R
mYdoe/BJ/J/6rHOjq7Omk24z2qB3RU1uAv57iY5VGw5p45uZB4C4pNNsBJXoCvPn
TGAs/7IrekFZDDgVraPx/hdiwopQ8NltSfZCyu/jPpWFK28TR8yfVlzYFwibj5WK
dHM7ZTqlA1tHIG+agyPf3Rae0jPMsHR6q+arXVwMccyOi+ULU0z8mHUJ3iEMIrpT
X+80KaN/ZjibfsBOCjcfiJSB/acn4nxQQgNZigna32velafhQivsNREFeJpzENiG
HOoyC6qVeOgKrRiKxzymj0FIMLru/iFF5pSWcBQB7PYlt8J0G80lAcPr6VCiN+4c
NKv03SdvA69dCOj79PuO9IIvQsJXsSq96HB+TeEmmL+xSdpGtGdCJHHM1fDeCqkZ
hT+RtBGQL2SEdWjxbF43oQopocT8cHvyX6Zaltn0svoGs+wX3Z/H6/8P5anog43U
65c0A+64Jj00rNDr8j31izhtQMRo892kGeQAaaxg4Pz6HnS7hRC+cOMHUU4HA7iM
zHrouAdYeTZeZEQOA7SxtCME9ZnGwe2grxPXh/U/80WJGkzLFNcTKdv+rwARAQAB
tDdEb2NrZXIgUmVsZWFzZSBUb29sIChyZWxlYXNlZG9ja2VyKSA8ZG9ja2VyQGRv
Y2tlci5jb20+iQI4BBMBAgAiBQJVpZ9uAhsvBgsJCAcDAgYVCAIJCgsEFgIDAQIe
AQIXgAAKCRD3YiFXLFJgnbRfEAC9Uai7Rv20QIDlDogRzd+Vebg4ahyoUdj0CH+n
Ak40RIoq6G26u1e+sdgjpCa8jF6vrx+smpgd1HeJdmpahUX0XN3X9f9qU9oj9A4I
1WDalRWJh+tP5WNv2ySy6AwcP9QnjuBMRTnTK27pk1sEMg9oJHK5p+ts8hlSC4Sl
uyMKH5NMVy9c+A9yqq9NF6M6d6/ehKfBFFLG9BX+XLBATvf1ZemGVHQusCQebTGv
0C0V9yqtdPdRWVIEhHxyNHATaVYOafTj/EF0lDxLl6zDT6trRV5n9F1VCEh4Aal8
L5MxVPcIZVO7NHT2EkQgn8CvWjV3oKl2GopZF8V4XdJRl90U/WDv/6cmfI08GkzD
YBHhS8ULWRFwGKobsSTyIvnbk4NtKdnTGyTJCQ8+6i52s+C54PiNgfj2ieNn6oOR
7d+bNCcG1CdOYY+ZXVOcsjl73UYvtJrO0Rl/NpYERkZ5d/tzw4jZ6FCXgggA/Zxc
jk6Y1ZvIm8Mt8wLRFH9Nww+FVsCtaCXJLP8DlJLASMD9rl5QS9Ku3u7ZNrr5HWXP
HXITX660jglyshch6CWeiUATqjIAzkEQom/kEnOrvJAtkypRJ59vYQOedZ1sFVEL
MXg2UCkD/FwojfnVtjzYaTCeGwFQeqzHmM241iuOmBYPeyTY5veF49aBJA1gEJOQ
TvBR8Q==
=Fm3p
-----END PGP PUBLIC KEY BLOCK-----
"
echo "$docker_key" | apt-key add -
echo "deb https://apt.dockerproject.org/repo ubuntu-xenial main" > /etc/apt/sources.list.d/docker.list
apt-get -y update

# create systemd drop-in file
mkdir -p /etc/systemd/system/docker.service.d
echo -e "[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// --log-driver=journald --exec-opt native.cgroupdriver=cgroupfs --storage-driver=devicemapper" > /etc/systemd/system/docker.service.d/cloudron.conf

apt-get -y --allow-downgrades install docker-engine=1.12.5-0~ubuntu-xenial # apt-cache madison docker-engine
apt-mark hold docker-engine # do not update docker
storage_driver=$(docker info | grep "Storage Driver" | sed 's/.*: //')
if [[ "${storage_driver}" != "devicemapper" ]]; then
    echo "Docker is using "${storage_driver}" instead of devicemapper"
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

