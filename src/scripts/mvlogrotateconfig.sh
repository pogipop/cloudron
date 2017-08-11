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

# TODO prevent this script from moving the file from $1 into a random dir with using a relative ../ path
if [[ "${BOX_ENV}" == "cloudron" ]]; then
	readonly destination_file_path="${HOME}/platformdata/logrotate.d/$2"
else
	readonly destination_file_path="${HOME}/.cloudron_test/platformdata/logrotate.d/$2"
fi

mv "${1}" "${destination_file_path}"
chown root:root "${destination_file_path}"
