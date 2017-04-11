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

    mkdir -p "${app_data_dir}/data"
    # only the top level ownership is changed because containers own the subdirectores
    # and will chown them as necessary
    chown yellowtent:yellowtent "${app_data_dir}"
    chown yellowtent:yellowtent "${app_data_dir}/data"
else
    readonly app_data_dir="${HOME}/.cloudron_test/appsdata/$1"
    mkdir -p "${app_data_dir}/data"
    chown ${SUDO_USER}:${SUDO_USER} "${app_data_dir}"
fi
