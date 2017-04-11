#!/bin/bash

set -eu -o pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "This script should be run as root." >&2
    exit 1
fi

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

readonly APPS_DATA_DIR="${HOME}/appsdata"

# verify argument count
if [[ $# -lt 2 ]]; then
    echo "Usage: backupbox.sh <backupId> <appId>"
    exit 1
fi

# extract arguments
readonly backup_id="$1"
readonly app_id="$2"

echo "Running app backup task"
DEBUG="box*" ${script_dir}/../backuptask.js "${backup_id}" "${app_id}"

echo "App backup successful"
