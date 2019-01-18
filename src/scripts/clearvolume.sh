#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

if [[ $# -eq 0 ]]; then
    echo "No arguments supplied"
    exit 1
fi

if [[ "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

cmd="$1"
volume_dir="$2"

if [[ "${BOX_ENV}" == "test" ]]; then
    # be careful not to nuke some random directory when testing
    [[ "${volume_dir}" != *"./cloudron_test/"* ]] && exit 1
fi

if [[ -d "${volume_dir}" ]]; then
    # this removes hidden files
    find "${volume_dir}" -maxdepth 1 -mindepth 1 -exec rm -rf '{}' \;
fi

if [[ "${cmd}" == "clear" ]]; then
    mkdir -p "${volume_dir}"
    # set it up so that we can restore here as normal user
    chown $SUDO_USER:$SUDO_USER "${volume_dir}"
else
    # this make not succeed if volume is a mount point
    rmdir "${volume_dir}" || true
fi