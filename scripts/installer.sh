#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

readonly USER=yellowtent
readonly BOX_SRC_DIR=/home/${USER}/box
readonly BASE_DATA_DIR=/home/${USER}
readonly CLOUDRON_CONF=/home/yellowtent/configs/cloudron.conf

readonly curl="curl --fail --connect-timeout 20 --retry 10 --retry-delay 2 --max-time 2400"
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly box_src_tmp_dir="$(realpath ${script_dir}/..)"

readonly is_update=$([[ -f "${CLOUDRON_CONF}" ]] && echo "yes" || echo "no")

arg_data=""
arg_data_dir=""

args=$(getopt -o "" -l "data:,data-file:,data-dir:" -n "$0" -- "$@")
eval set -- "${args}"

while true; do
    case "$1" in
    --data) arg_data="$2"; shift 2;;
    --data-file) arg_data=$(cat $2); shift 2;;
    --data-dir) arg_data_dir="$2"; shift 2;;
    --) break;;
    *) echo "Unknown option $1"; exit 1;;
    esac
done

echo "==> installer: updating docker"
if [[ $(docker version --format {{.Client.Version}}) != "17.12.1-ce" ]]; then
    $curl -sL https://download.docker.com/linux/ubuntu/dists/xenial/pool/stable/amd64/docker-ce_17.12.1~ce-0~ubuntu_amd64.deb -o /tmp/docker.deb

    # https://download.docker.com/linux/ubuntu/dists/xenial/stable/binary-amd64/Packages
    if [[ $(sha256sum /tmp/docker.deb | cut -d' ' -f1) != "db9a541ec923c0956dc8d3ecbf14aef76618ca6016fb57e27c55d029ed5f076c" ]]; then
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

    while ! apt install -y /tmp/docker.deb; do
        echo "==> installer: Failed to install docker. Retry"
        sleep 1
    done

    rm /tmp/docker.deb
fi

echo "==> installer: updating node"
if [[ "$(node --version)" != "v8.9.3" ]]; then
    mkdir -p /usr/local/node-8.9.3
    $curl -sL https://nodejs.org/dist/v8.9.3/node-v8.9.3-linux-x64.tar.gz | tar zxvf - --strip-components=1 -C /usr/local/node-8.9.3
    ln -sf /usr/local/node-8.9.3/bin/node /usr/bin/node
    ln -sf /usr/local/node-8.9.3/bin/npm /usr/bin/npm
    rm -rf /usr/local/node-6.11.5
fi

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

if ! id "${USER}" 2>/dev/null; then
    useradd "${USER}" -m
fi

if [[ "${is_update}" == "yes" ]]; then
    echo "==> installer: stop cloudron.target service for update"
    ${BOX_SRC_DIR}/setup/stop.sh
fi

# setup links to data directory
if [[ -n "${arg_data_dir}" ]]; then
    echo "==> installer: setting up links to data directory"
    mkdir "${arg_data_dir}/appsdata"
    ln -s "${arg_data_dir}/appsdata" "${BASE_DATA_DIR}/appsdata"
    mkdir "${arg_data_dir}/platformdata"
    ln -s "${arg_data_dir}/platformdata" "${BASE_DATA_DIR}/platformdata"
fi

# ensure we are not inside the source directory, which we will remove now
cd /root

echo "==> installer: switching the box code"
rm -rf "${BOX_SRC_DIR}"
mv "${box_src_tmp_dir}" "${BOX_SRC_DIR}"
chown -R "${USER}:${USER}" "${BOX_SRC_DIR}"

echo "==> installer: calling box setup script"
"${BOX_SRC_DIR}/setup/start.sh" --data "${arg_data}"
