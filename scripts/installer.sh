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

for try in `seq 1 10`; do
    # for reasons unknown, the dtrace package will fail. but rebuilding second time will work

    # We need --unsafe-perm as we run as root and the folder is owned by root,
    # however by default npm drops privileges for npm rebuild
    # https://docs.npmjs.com/misc/config#unsafe-perm
    if cd "${box_src_tmp_dir}" && npm rebuild --unsafe-perm; then break; fi
    echo "Failed to rebuild, trying again"
    sleep 5
done

if [[ ${try} -eq 10 ]]; then
    echo "npm rebuild failed"
    exit 4
fi

if ! id "${USER}" 2>/dev/null; then
    useradd "${USER}" -m
fi

if [[ "${is_update}" == "yes" ]]; then
    echo "Setting up update splash screen"
    "${box_src_tmp_dir}/setup/splashpage.sh" --data "${arg_data}" || true # show splash from new code
    ${BOX_SRC_DIR}/setup/stop.sh # stop the old code
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

echo "==> installer: updating packages"
if [[ $(docker version --format {{.Client.Version}}) != "17.03.1-ce" ]]; then
    $curl -sL https://download.docker.com/linux/ubuntu/dists/xenial/pool/stable/amd64/docker-ce_17.03.1~ce-0~ubuntu-xenial_amd64.deb -o /tmp/docker.deb
    # https://download.docker.com/linux/ubuntu/dists/xenial/stable/binary-amd64/Packages
    if [[ $(md5sum /tmp/docker.deb | cut -d' ' -f1) != "d6d175900edd243abbdb253990b2fe59" ]]; then
        echo "docker binary download is corrupt"
        exit 5
    fi

    echo "Waiting for all dpkg tasks to finish..."
    while fuser /var/lib/dpkg/lock; do
        sleep 1
    done

    if ! apt-get remove -y --allow-change-held-packages docker-engine; then
        echo "Failed to remove outdated docker-engine"
        exit 5
    fi

    if ! apt install -y /tmp/docker.deb; then
        echo "Failed to install docker"
        exit 5
    fi

    rm /tmp/docker.deb
fi

echo "==> installer: switching the box code"
rm -rf "${BOX_SRC_DIR}"
mv "${box_src_tmp_dir}" "${BOX_SRC_DIR}"
chown -R "${USER}:${USER}" "${BOX_SRC_DIR}"

echo "==> installer: calling box setup script"
"${BOX_SRC_DIR}/setup/start.sh" --data "${arg_data}"
