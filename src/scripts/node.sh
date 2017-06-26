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

echo "Running node with memory constraints"

# note BOX_ENV and NODE_ENV are derived from parent process
exec env "DEBUG=box*,connect-lastmile" /usr/bin/node --max_old_space_size=300 "$@"
