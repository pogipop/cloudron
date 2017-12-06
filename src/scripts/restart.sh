#!/bin/bash

set -eu -o pipefail

readonly INFRA_VERSION_FILE=/home/yellowtent/platformdata/INFRA_VERSION

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    systemctl restart box
fi

