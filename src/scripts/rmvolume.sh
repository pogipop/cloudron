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

volume_dir="$1"

if [[ "${BOX_ENV}" == "test" ]]; then
    # be careful not to nuke some random directory when testing
    [[ "${volume_dir}" != *"./cloudron_test/"* ]] && exit 1
fi

# this removes hidden files
find "${volume_dir}" -maxdepth 1 -mindepth 1 -exec rm -rf '{}' \;
# volume could be a mount point that cannot be deleted
rmdir "${volume_dir}" || true

