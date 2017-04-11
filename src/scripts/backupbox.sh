#!/bin/bash

set -eu -o pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BOX_DATA_DIR="${HOME}/boxdata"

if [[ $EUID -ne 0 ]]; then
    echo "This script should be run as root." >&2
    exit 1
fi

if [[ $# == 1 && "$1" == "--check" ]]; then
    echo "OK"
    exit 0
fi

# verify argument count
if [[ $# -lt 1 ]]; then
    echo "Usage: backupbox.sh <backupId>"
    exit 1
fi

# extract arguments
readonly backup_id="$1"

echo "Creating MySQL dump"
mysqldump -u root -ppassword --single-transaction --routines --triggers box > "${BOX_DATA_DIR}/box.mysqldump"

echo "Running backup task"
DEBUG="box*" ${script_dir}/../backuptask.js "${backup_id}"

echo "Backup successful"
