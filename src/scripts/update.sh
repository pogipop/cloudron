#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

readonly UPDATER_SERVICE="cloudron-updater"
readonly DATETIME=`date '+%Y-%m-%d_%H-%M-%S'`
readonly LOG_FILE="/var/log/cloudron-updater-${DATETIME}.log"

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

if [[ $# != 1 ]]; then
    echo "sourceDir argument required"
    exit 1
fi

readonly source_dir="${1}"

echo "Updating Cloudron with ${source_dir}"

readonly installer_path="${source_dir}/scripts/installer.sh"

echo "=> reset service ${UPDATER_SERVICE} status in case it failed"
if systemctl reset-failed "${UPDATER_SERVICE}"; then
    echo "=> service has failed earlier"
fi

# StandardError will follow StandardOutput in default inherit mode. https://www.freedesktop.org/software/systemd/man/systemd.exec.html
echo "=> Run installer.sh as cloudron-updater.service"
if ! systemd-run --unit "${UPDATER_SERVICE}" -p "StandardOutput=file:${LOG_FILE}" ${installer_path}; then
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
