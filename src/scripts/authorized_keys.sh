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

# verify argument count
if [[ $# -lt 3 ]]; then
    echo "Usage: authorized_keys.sh <user> <source> <destination>"
    exit 1
fi

if [[ -f "$2" ]]; then
    # on some vanilla ubuntu installs, the .ssh directory does not exist
    mkdir -p "$(dirname $3)"

    cp "$2" "$3"
    chown "$1":"$1" "$3"
fi
