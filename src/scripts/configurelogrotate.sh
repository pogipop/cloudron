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
appid="$2"

if [[ "${cmd}" == "add" ]]; then
    # TODO prevent this script from moving the file from $1 into a random dir with using a relative ../ path
    if [[ "${BOX_ENV}" == "cloudron" ]]; then
        readonly destination_file_path="${HOME}/platformdata/logrotate.d/${appid}"
    else
        readonly destination_file_path="${HOME}/.cloudron_test/platformdata/logrotate.d/${appid}"
    fi

    mv "${3}" "${destination_file_path}"
    chown root:root "${destination_file_path}"
elif [[ "${cmd}" == "remove" ]]; then
    if [[ "${BOX_ENV}" == "cloudron" ]]; then
        rm -rf "${HOME}/platformdata/logrotate.d/${appid}"
    else
        rm -rf "${HOME}/.cloudron_test/platformdata/logrotate.d/${appid}"
    fi
fi

