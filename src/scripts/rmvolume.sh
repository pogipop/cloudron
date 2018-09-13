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

# this script is called from redis addon as well!

appid="$1"
subdir="$2"

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    readonly volume_dir="${HOME}/appsdata/${appid}/${subdir}"
else
    readonly volume_dir="${HOME}/.cloudron_test/appsdata/${appid}/${subdir}"
fi

rm -rf "${volume_dir}"

