#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

readonly UPDATER_SERVICE="cloudron-updater"
readonly DATA_FILE="/root/cloudron-update-data.json"
readonly curl="curl --fail --connect-timeout 20 --retry 10 --retry-delay 2 --max-time 300"

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

if [[ $# != 2 ]]; then
    echo "sourceTarballUrl and data arguments required"
    exit 1
fi

readonly sourceTarballUrl="${1}"
readonly data="${2}"

echo "Updating Cloudron with ${sourceTarballUrl}"
echo "${data}"

# TODO: pre-download tarball
box_src_tmp_dir=$(mktemp -dt box-src-XXXXXX)
readonly installer_path="${box_src_tmp_dir}/scripts/installer.sh"
echo "Downloading box code from ${sourceTarballUrl} to ${box_src_tmp_dir}"

for try in `seq 1 10`; do
    if $curl -L "${sourceTarballUrl}" | tar -zxf - -C "${box_src_tmp_dir}"; then break; fi
    echo "Failed to download source tarball, trying again"
    sleep 5
done

if [[ ${try} -eq 10 ]]; then
    echo "Release tarball download failed"
    exit 3
fi

echo "=> reset service ${UPDATER_SERVICE} status in case it failed"
if systemctl reset-failed "${UPDATER_SERVICE}"; then
    echo "=> service has failed earlier"
fi

# Save user data in file, to avoid argument length limit with systemd-run
echo "${data}" > "${DATA_FILE}"

echo "=> Run installer.sh as cloudron-updater.service"
if ! systemd-run --unit "${UPDATER_SERVICE}" ${installer_path} --data-file "${DATA_FILE}"; then
    echo "Failed to install cloudron. See ${LOG_FILE} for details"
    exit 1
fi

echo "=> service ${UPDATER_SERVICE} started."
echo "=> See logs with journalctl -u ${UPDATER_SERVICE} -f"

while true; do
    if systemctl is-failed "${UPDATER_SERVICE}"; then
        echo "=> ${UPDATER_SERVICE} has failed"
        exit 1
    fi

    sleep 5
    # this loop will stop once the update process stopped the box unit and thus terminating this child process
done
