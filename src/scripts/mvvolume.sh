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

source_dir="$1"
target_dir="$2"

if [[ "${BOX_ENV}" == "test" ]]; then
    # be careful not to nuke some random directory when testing
    [[ "${source_dir}" != *"./cloudron_test/"* ]] && exit 1
    [[ "${target_dir}" != *"./cloudron_test/"* ]] && exit 1
fi

# copy and remove - this way if the copy fails, the original is intact
# the find logic is so that move to a subdir works (and we also move hidden files)
find "${source_dir}" -maxdepth 1 -mindepth 1 -not -wholename "${target_dir}" -exec cp -ar '{}' "${target_dir}" \;
find "${source_dir}" -maxdepth 1 -mindepth 1 -not -wholename "${target_dir}" -exec rm -rf '{}' \;
# this will fail if target is a subdir
rmdir "${source_dir}" || true

