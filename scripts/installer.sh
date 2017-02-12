#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

readonly USER=yellowtent
readonly BOX_SRC_DIR=/home/${USER}/box
readonly CLOUDRON_CONF=/home/yellowtent/configs/cloudron.conf

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly box_src_tmp_dir="$(realpath ${script_dir}/..)"

readonly is_update=$([[ -f "${CLOUDRON_CONF}" ]] && echo "yes" || echo "no")

arg_data=""

args=$(getopt -o "" -l "data:,data-file:" -n "$0" -- "$@")
eval set -- "${args}"

while true; do
    case "$1" in
    --data) arg_data="$2"; shift 2;;
    --data-file) arg_data=$(cat $2); shift 2;;
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
    # This is here, since the splash screen needs this file to be present :-(
    readonly DATA_DIR="/home/${USER}/data"
    if [[ ! -f "${DATA_DIR}/nginx/cert/dhparams.pem" ]]; then
        mkdir -p "${DATA_DIR}/nginx/cert/"
        openssl dhparam -out "${DATA_DIR}/nginx/cert/dhparams.pem" 2048
    fi

    echo "Setting up update splash screen"
    "${box_src_tmp_dir}/setup/splashpage.sh" --data "${arg_data}" # show splash from new code
    ${BOX_SRC_DIR}/setup/stop.sh # stop the old code
fi

# ensure we are not inside the source directory, which we will remove now
cd /root

echo "==> installer: switching the box code"
rm -rf "${BOX_SRC_DIR}"
mv "${box_src_tmp_dir}" "${BOX_SRC_DIR}"
chown -R "${USER}:${USER}" "${BOX_SRC_DIR}"

echo "==> installer: calling box setup script"
"${BOX_SRC_DIR}/setup/start.sh" --data "${arg_data}"
