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

appid="$1"
rmdir="$2"

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    readonly app_data_dir="${HOME}/appsdata/${appid}"
else
    readonly app_data_dir="${HOME}/.cloudron_test/appsdata/${appid}"
fi

if [[ "${rmdir}" == "true" ]]; then
    rm -rf "${app_data_dir}"
else
    find "${app_data_dir}" -mindepth 1 -delete
fi
