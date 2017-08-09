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

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    readonly app_data_dir="${HOME}/appsdata/$1"
else
    readonly app_data_dir="${HOME}/.cloudron_test/appsdata/$1"
fi

(cd "${app_data_dir}/data" && find . -type d -empty) > "${app_data_dir}/emptydirs.txt"

