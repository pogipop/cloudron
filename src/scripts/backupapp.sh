#!/bin/bash

set -eu -o pipefail

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
if [[ "$1" == "s3" && $# -lt 9 ]]; then
    echo "Usage: backupapp.sh s3 <appId> <s3 config url> <s3 data url> <access key id> <access key> <region> <endpoint> <password> [session token]"
    exit 1
fi

if [[ "$1" == "filesystem" && $# -lt 6 ]]; then
    echo "Usage: backupapp.sh filesystem <appId> <backupFolder> <configFileName> <dataFileName> <password>"
    exit 1
fi


# extract arguments
readonly app_id="$2"

if [[ "$1" == "s3" ]]; then
    # env vars used by the awscli
    readonly s3_config_url="$3"
    readonly s3_data_url="$4"
    export AWS_ACCESS_KEY_ID="$5"
    export AWS_SECRET_ACCESS_KEY="$6"
    export AWS_DEFAULT_REGION="$7"
    readonly endpoint_url="$8"
    readonly password="$9"

    if [ $# -gt 9 ]; then
        export AWS_SESSION_TOKEN="${10}"
    fi
elif [[ "$1" == "filesystem" ]]; then
    readonly backup_folder="$3"
    readonly backup_config_fileName="$4"
    readonly backup_data_fileName="$5"
    readonly password="$6"
fi

# perform backup
readonly app_data_dir="${APPS_DATA_DIR}/${app_id}"

# will be checked at the end
try=0

if [[ "$1" == "s3" ]]; then
    # may be empty
    optional_args=""
    if [ -n "${endpoint_url}" ]; then
        optional_args="--endpoint-url ${endpoint_url}"
    fi

    # Upload config.json first because uploading tarball might take a lot of time, leading to token expiry
    for try in `seq 1 5`; do
        echo "Uploading config.json to ${s3_config_url} (try ${try})"
        error_log=$(mktemp)

        # use aws instead of curl because curl will always read entire stream memory to set Content-Length
        # aws will do multipart upload
        if cat "${app_data_dir}/config.json" \
               |  aws ${optional_args} s3 cp - "${s3_config_url}" 2>"${error_log}"; then
            break
        fi
        cat "${error_log}" && rm "${error_log}"
    done

    for try in `seq 1 5`; do
        echo "Uploading backup to ${s3_data_url} (try ${try})"
        error_log=$(mktemp)

        if tar -czf - -C "${app_data_dir}" . \
               | openssl aes-256-cbc -e -pass "pass:${password}" \
               |  aws ${optional_args} s3 cp - "${s3_data_url}" 2>"${error_log}"; then
            break
        fi
        cat "${error_log}" && rm "${error_log}"
    done
elif [[ "$1" == "filesystem" ]]; then
    mkdir -p $(dirname "${backup_folder}/${backup_config_fileName}")

    echo "Storing backup config to ${backup_folder}/${backup_config_fileName}"
    cat "${app_data_dir}/config.json" > "${backup_folder}/${backup_config_fileName}"

    echo "Storing backup data to ${backup_folder}/${backup_data_fileName}"
    tar -czf - -C "${app_data_dir}" . | openssl aes-256-cbc -e -pass "pass:${password}" > "${backup_folder}/${backup_data_fileName}"
fi

if [[ ${try} -eq 5 ]]; then
    echo "Backup failed uploading backup tarball"
    exit 3
else
    echo "Backup successful"
fi
