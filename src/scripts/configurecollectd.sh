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

cmd="$1"
appid="$2"

if [[ "${BOX_ENV}" == "cloudron" ]]; then
    # when restoring the cloudron with many apps, the apptasks rush in to restart
    # collectd which makes systemd/collectd very unhappy and puts the collectd in
    # inactive state
    for i in {1..10}; do
        echo "Restarting collectd"
        if systemctl restart collectd; then
            break
        fi
        echo "Failed to reload collectd. Maybe some other apptask is restarting it"
        sleep $((RANDOM%30))
    done

    # delete old stats when uninstalling an app
    if [[ "${cmd}" == "remove" ]]; then
        echo "Removing collectd stats of ${appid}"

        for i in {1..10}; do
            if rm -rf ${HOME}/platformdata/graphite/whisper/collectd/localhost/*${appid}*; then
                break
            fi
            echo "Failed to remove collectd directory. collectd possibly generated data in the middle of removal"
            sleep 3
        done
    fi
fi

