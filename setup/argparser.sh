#!/bin/bash

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
json="${source_dir}/../node_modules/.bin/json"

arg_api_server_origin=""
arg_fqdn=""         # remove after 1.10
arg_admin_domain=""
arg_admin_location=""
arg_admin_fqdn=""
arg_retire_reason=""
arg_retire_info=""
arg_version=""
arg_web_server_origin=""
arg_provider=""
arg_is_demo="false"
arg_edition=""

args=$(getopt -o "" -l "data:,retire-reason:,retire-info:" -n "$0" -- "$@")
eval set -- "${args}"

while true; do
    case "$1" in
    --retire-reason)
        arg_retire_reason="$2"
        shift 2
        ;;
    --retire-info)
        arg_retire_info="$2"
        shift 2
        ;;
    --data)
        # these params must be valid in all cases
        arg_fqdn=$(echo "$2" | $json fqdn)
        arg_admin_fqdn=$(echo "$2" | $json adminFqdn)

        arg_admin_location=$(echo "$2" | $json adminLocation)
        [[ "${arg_admin_location}" == "" ]] && arg_admin_location="my"

        arg_admin_domain=$(echo "$2" | $json adminDomain)
        [[ "${arg_admin_domain}" == "" ]] && arg_admin_domain="${arg_fqdn}"

        # only update/restore have this valid (but not migrate)
        arg_api_server_origin=$(echo "$2" | $json apiServerOrigin)
        [[ "${arg_api_server_origin}" == "" ]] && arg_api_server_origin="https://api.cloudron.io"
        arg_web_server_origin=$(echo "$2" | $json webServerOrigin)
        [[ "${arg_web_server_origin}" == "" ]] && arg_web_server_origin="https://cloudron.io"

        # TODO check if and where this is used
        arg_version=$(echo "$2" | $json version)

        # read possibly empty parameters here
        arg_is_demo=$(echo "$2" | $json isDemo)
        [[ "${arg_is_demo}" == "" ]] && arg_is_demo="false"

        arg_provider=$(echo "$2" | $json provider)
        [[ "${arg_provider}" == "" ]] && arg_provider="generic"

        arg_edition=$(echo "$2" | $json edition)
        [[ "${arg_edition}" == "" ]] && arg_edition=""

        shift 2
        ;;
    --) break;;
    *) echo "Unknown option $1"; exit 1;;
    esac
done

echo "Parsed arguments:"
echo "api server: ${arg_api_server_origin}"
echo "admin fqdn: ${arg_admin_fqdn}"
echo "fqdn: ${arg_fqdn}"
echo "version: ${arg_version}"
echo "web server: ${arg_web_server_origin}"
echo "provider: ${arg_provider}"
echo "edition: ${arg_edition}"
