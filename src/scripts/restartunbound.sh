#!/bin/bash

set -eu -o pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    unbound-anchor -a /var/lib/unbound/root.key
    systemctl restart unbound
fi

