#!/bin/bash

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
json="${source_dir}/../node_modules/.bin/json"

# IMPORTANT: Fix cloudron.js:doUpdate if you add/remove any arg. keep these sorted for readability
arg_api_server_origin=""
arg_fqdn=""
arg_zone_name=""
arg_is_custom_domain="false"
arg_restore_key=""
arg_restore_url=""
arg_retire_reason=""
arg_retire_info=""
arg_tls_config=""
arg_tls_cert=""
arg_tls_key=""
arg_token=""
arg_version=""
arg_web_server_origin=""
arg_backup_config=""
arg_dns_config=""
arg_provider=""
arg_app_bundle=""
arg_is_demo="false"

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
        arg_zone_name=$(echo "$2" | $json zoneName)

        arg_is_custom_domain=$(echo "$2" | $json isCustomDomain)
        [[ "${arg_is_custom_domain}" == "" ]] && arg_is_custom_domain="true"

        # only update/restore have this valid (but not migrate)
        arg_api_server_origin=$(echo "$2" | $json apiServerOrigin)
        [[ "${arg_api_server_origin}" == "" ]] && arg_api_server_origin="https://api.cloudron.io"
        arg_web_server_origin=$(echo "$2" | $json webServerOrigin)
        [[ "${arg_web_server_origin}" == "" ]] && arg_web_server_origin="https://cloudron.io"

        # TODO check if an where this is used
        arg_version=$(echo "$2" | $json version)

        # read possibly empty parameters here
        arg_app_bundle=$(echo "$2" | $json appBundle)
        [[ "${arg_app_bundle}" == "" ]] && arg_app_bundle="[]"

        arg_is_demo=$(echo "$2" | $json isDemo)
        [[ "${arg_is_demo}" == "" ]] && arg_is_demo="false"

        arg_tls_cert=$(echo "$2" | $json tlsCert)
        [[ "${arg_tls_cert}" == "null" ]] && arg_tls_cert=""
        arg_tls_key=$(echo "$2" | $json tlsKey)
        [[ "${arg_tls_key}" == "null" ]] && arg_tls_key=""
        arg_token=$(echo "$2" | $json token)

        arg_provider=$(echo "$2" | $json provider)
        [[ "${arg_provider}" == "" ]] && arg_provider="generic"

        arg_tls_config=$(echo "$2" | $json tlsConfig)
        [[ "${arg_tls_config}" == "null" ]] && arg_tls_config=""

        arg_restore_url=$(echo "$2" | $json restore.url)
        [[ "${arg_restore_url}" == "null" ]] && arg_restore_url=""

        arg_restore_key=$(echo "$2" | $json restore.key)
        [[ "${arg_restore_key}" == "null" ]] && arg_restore_key=""

        arg_backup_config=$(echo "$2" | $json backupConfig)
        [[ "${arg_backup_config}" == "null" ]] && arg_backup_config=""

        arg_dns_config=$(echo "$2" | $json dnsConfig)
        [[ "${arg_dns_config}" == "null" ]] && arg_dns_config=""

        shift 2
        ;;
    --) break;;
    *) echo "Unknown option $1"; exit 1;;
    esac
done

echo "Parsed arguments:"
echo "api server: ${arg_api_server_origin}"
echo "fqdn: ${arg_fqdn}"
echo "custom domain: ${arg_is_custom_domain}"
echo "restore url: ${arg_restore_url}"
echo "tls cert: ${arg_tls_cert}"
# do not dump these as they might become available via logs API
#echo "restore key: ${arg_restore_key}"
#echo "tls key: ${arg_tls_key}"
#echo "token: ${arg_token}"
echo "tlsConfig: ${arg_tls_config}"
echo "version: ${arg_version}"
echo "web server: ${arg_web_server_origin}"
echo "provider: ${arg_provider}"
