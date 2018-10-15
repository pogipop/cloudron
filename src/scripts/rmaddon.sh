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

addon="$1"
appid="${2:-}"   # only valid for redis
if [[ "${addon}" != "postgresql" && "${addon}" != "mysql" && "${addon}" != "mongodb" && "${addon}" != "redis" ]]; then
    echo "${addon} must be postgresql/mysql/mongodb/redis"
    exit 1
fi

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    readonly addon_dir="${HOME}/platformdata/${addon}"
else
    readonly addon_dir="${HOME}/.cloudron_test/platformdata/${addon}"
fi

rm -rf "${addon_dir}"
if [[ "${addon}" != "redis" ]]; then
    mkdir "${addon_dir}"
fi

