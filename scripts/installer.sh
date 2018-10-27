#!/bin/bash

# This script is run before the box code is switched. This means that we can
# put network related/curl downloads here. If the script fails, the old code
# will continue to run

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

readonly USER=yellowtent
readonly BOX_SRC_DIR=/home/${USER}/box
readonly BASE_DATA_DIR=/home/${USER}

readonly curl="curl --fail --connect-timeout 20 --retry 10 --retry-delay 2 --max-time 2400"
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly box_src_tmp_dir="$(realpath ${script_dir}/..)"

readonly is_update=$(systemctl is-active box && echo "yes" || echo "no")

echo "==> installer: updating docker"
if [[ $(docker version --format {{.Client.Version}}) != "18.03.1-ce" ]]; then
    $curl -sL https://download.docker.com/linux/ubuntu/dists/xenial/pool/stable/amd64/docker-ce_18.03.1~ce-0~ubuntu_amd64.deb -o /tmp/docker.deb

    # https://download.docker.com/linux/ubuntu/dists/xenial/stable/binary-amd64/Packages
    if [[ $(sha256sum /tmp/docker.deb | cut -d' ' -f1) != "54f4c9268492a4fd2ec2e6bcc95553855b025f35dcc8b9f60ac34e0aa307279b" ]]; then
        echo "==> installer: docker binary download is corrupt"
        exit 5
    fi

    echo "==> installer: Waiting for all dpkg tasks to finish..."
    while fuser /var/lib/dpkg/lock; do
        sleep 1
    done

    while ! dpkg --force-confold --configure -a; do
        echo "==> installer: Failed to fix packages. Retry"
        sleep 1
    done

    # the latest docker might need newer packages
    while ! apt update -y; do
        echo "==> installer: Failed to update packages. Retry"
        sleep 1
    done

    while ! apt install -y /tmp/docker.deb; do
        echo "==> installer: Failed to install docker. Retry"
        sleep 1
    done

    rm /tmp/docker.deb
fi

echo "==> installer: updating node"
if [[ "$(node --version)" != "v8.11.2" ]]; then
    mkdir -p /usr/local/node-8.11.2
    $curl -sL https://nodejs.org/dist/v8.11.2/node-v8.11.2-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-8.11.2
    ln -sf /usr/local/node-8.11.2/bin/node /usr/bin/node
    ln -sf /usr/local/node-8.11.2/bin/npm /usr/bin/npm
    rm -rf /usr/local/node-6.11.5
fi

# this is here (and not in updater.js) because rebuild requires the above node
for try in `seq 1 10`; do
    # for reasons unknown, the dtrace package will fail. but rebuilding second time will work

    # We need --unsafe-perm as we run as root and the folder is owned by root,
    # however by default npm drops privileges for npm rebuild
    # https://docs.npmjs.com/misc/config#unsafe-perm
    if cd "${box_src_tmp_dir}" && npm rebuild --unsafe-perm; then break; fi
    echo "==> installer: Failed to rebuild, trying again"
    sleep 5
done

if [[ ${try} -eq 10 ]]; then
    echo "==> installer: npm rebuild failed, giving up"
    exit 4
fi

echo "==> installer: downloading new addon images"
images=$(node -e "var i = require('${box_src_tmp_dir}/src/infra_version.js'); console.log(i.baseImages.map(function (x) { return x.tag; }).join(' '), Object.keys(i.images).map(function (x) { return i.images[x].tag; }).join(' '));")

echo -e "\tPulling docker images: ${images}"
for image in ${images}; do
    docker pull "${image}"           # this pulls the image using the sha256
    docker pull "${image%@sha256:*}" # this will tag the image for readability
done

echo "==> installer: update cloudron-syslog"
CLOUDRON_SYSLOG_DIR=/usr/local/cloudron-syslog
CLOUDRON_SYSLOG="${CLOUDRON_SYSLOG_DIR}/bin/cloudron-syslog"
CLOUDRON_SYSLOG_VERSION="1.0.3"
while [[ ! -f "${CLOUDRON_SYSLOG}" || "$(${CLOUDRON_SYSLOG} --version)" != ${CLOUDRON_SYSLOG_VERSION} ]]; do
    rm -rf "${CLOUDRON_SYSLOG_DIR}"
    mkdir -p "${CLOUDRON_SYSLOG_DIR}"
    if npm install --unsafe-perm -g --prefix "${CLOUDRON_SYSLOG_DIR}" cloudron-syslog@${CLOUDRON_SYSLOG_VERSION}; then break; fi
    echo "===> installer: Failed to install cloudron-syslog, trying again"
    sleep 5
done

if ! id "${USER}" 2>/dev/null; then
    useradd "${USER}" -m
fi

if [[ "${is_update}" == "yes" ]]; then
    echo "==> installer: stop cloudron.target service for update"
    ${BOX_SRC_DIR}/setup/stop.sh
fi

# ensure we are not inside the source directory, which we will remove now
cd /root

echo "==> installer: switching the box code"
rm -rf "${BOX_SRC_DIR}"
mv "${box_src_tmp_dir}" "${BOX_SRC_DIR}"
chown -R "${USER}:${USER}" "${BOX_SRC_DIR}"

echo "==> installer: calling box setup script"
"${BOX_SRC_DIR}/setup/start.sh"
