#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

readonly UPDATER_SERVICE="cloudron-updater"

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
echo "=> Run installer.sh as ${UPDATER_SERVICE}."
if [[ "$(systemd --version | head -n1)" != "systemd 22"* ]]; then
    readonly DATETIME=`date '+%Y-%m-%d_%H-%M-%S'`
    readonly LOG_FILE="/home/yellowtent/platformdata/logs/updater/cloudron-updater-${DATETIME}.log"

    update_service_options="-p StandardOutput=file:${LOG_FILE}"
    echo "=> starting service (ubuntu 18.04) ${UPDATER_SERVICE}. see logs at ${LOG_FILE}"
else
    update_service_options=""
    echo "=> starting service (ubuntu 16.04) ${UPDATER_SERVICE}. see logs using journalctl -u ${UPDATER_SERVICE}"
fi

if ! systemd-run --unit "${UPDATER_SERVICE}" $update_service_options ${installer_path}; then
    echo "Failed to install cloudron. See log for details"
    exit 1
fi

while true; do
    if systemctl is-failed "${UPDATER_SERVICE}" >/dev/null 2>&1; then
        echo "=> ${UPDATER_SERVICE} has failed"
        exit 1
    fi

    echo "${UPDATER_SERVICE} is still active. will check in 5 seconds"

    sleep 5
    # this loop will stop once the update process stopped the box unit and thus terminating this child process
done
