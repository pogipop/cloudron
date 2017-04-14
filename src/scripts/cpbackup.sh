#!/bin/bash

# This is part of the storage/filesystem backend!

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

if [[ $# -lt 2 ]]; then
    echo "Usage: cpbackup.sh <source> <destination>"
    exit 1
fi

# ensure destination path
readonly DEST_PATH=$(dirname "${2}")
mkdir -p "${DEST_PATH}"

# copy the file
cp "${1}" "${2}"
