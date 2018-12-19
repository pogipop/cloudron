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

CLOUDRON_SUPPORT_PUBLIC_KEY='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDQVilclYAIu+ioDp/sgzzFz6YU0hPcRYY7ze/LiF/lC7uQqK062O54BFXTvQ3ehtFZCx3bNckjlT2e6gB8Qq07OM66De4/S/g+HJW4TReY2ppSPMVNag0TNGxDzVH8pPHOysAm33LqT2b6L/wEXwC6zWFXhOhHjcMqXvi8Ejaj20H1HVVcf/j8qs5Thkp9nAaFTgQTPu8pgwD8wDeYX1hc9d0PYGesTADvo6HF4hLEoEnefLw7PaStEbzk2fD3j7/g5r5HcgQQXBe74xYZ/1gWOX2pFNuRYOBSEIrNfJEjFJsqk3NR1+ZoMGK7j+AZBR4k0xbrmncQLcQzl6MMDzkp support@cloudron.io'

cmd="$1"
keys_file="$2"
user="${3:-1000}"

if [[ "$1" == "is-enabled" ]]; then
    if grep -q "${CLOUDRON_SUPPORT_PUBLIC_KEY}" "${keys_file}"; then
        echo "true"
    else
        echo "false"
    fi
elif [[ "$1" == "enable" ]]; then
    mkdir -p $(dirname "${keys_file}")       # .ssh does not exist sometimes
    touch "${keys_file}"                # required for concat to work
    if ! grep -q "${CLOUDRON_SUPPORT_PUBLIC_KEY}" "${keys_file}"; then
        echo -e "\n${CLOUDRON_SUPPORT_PUBLIC_KEY}" >> "${keys_file}"
        chmod 600 "${keys_file}"
        chown "${user}" "${keys_file}"
    fi
elif [[ "$1" == "disable" ]]; then
    if [[ -f "${keys_file}" ]]; then
        sed -e "/ support@cloudron.io$/d" -i "${keys_file}"
    fi
fi

