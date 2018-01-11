#!/bin/bash

set -eu -o pipefail

readonly SETUP_WEBSITE_DIR="/home/yellowtent/setup/website"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly box_src_dir="$(realpath ${script_dir}/..)"
readonly PLATFORM_DATA_DIR="/home/yellowtent/platformdata"

echo "Setting up nginx update page"

if [[ ! -f "${PLATFORM_DATA_DIR}/nginx/applications/admin.conf" ]]; then
    echo "No admin.conf found. This Cloudron has no domain yet. Skip splash setup"
    exit
fi

source "${script_dir}/argparser.sh" "$@" # this injects the arg_* variables used below

# keep this is sync with config.js appFqdn()
admin_origin="https://${arg_admin_fqdn}"

# copy the website
rm -rf "${SETUP_WEBSITE_DIR}" && mkdir -p "${SETUP_WEBSITE_DIR}"
cp -r "${script_dir}/splash/website/"* "${SETUP_WEBSITE_DIR}"

# create nginx config
readonly current_infra=$(node -e "console.log(require('${script_dir}/../src/infra_version.js').version);")
existing_infra="none"
[[ -f "${PLATFORM_DATA_DIR}/INFRA_VERSION" ]] && existing_infra=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${PLATFORM_DATA_DIR}/INFRA_VERSION', 'utf8')).version);")
if [[ "${arg_retire_reason}" != "" || "${existing_infra}" != "${current_infra}" ]]; then
    echo "Showing progress bar on all subdomains in retired mode or infra update. retire: ${arg_retire_reason} existing: ${existing_infra} current: ${current_infra}"
    rm -f ${PLATFORM_DATA_DIR}/nginx/applications/*
    ${box_src_dir}/node_modules/.bin/ejs-cli -f "${script_dir}/start/nginx/appconfig.ejs" \
        -O "{ \"vhost\": \"~^(.+)\$\", \"adminOrigin\": \"${admin_origin}\", \"endpoint\": \"splash\", \"sourceDir\": \"${SETUP_WEBSITE_DIR}\", \"certFilePath\": \"cert/host.cert\", \"keyFilePath\": \"cert/host.key\", \"xFrameOptions\": \"SAMEORIGIN\", \"robotsTxtQuoted\": null, \"hasIPv6\": false }" > "${PLATFORM_DATA_DIR}/nginx/applications/admin.conf"
else
    echo "Show progress bar only on admin domain for normal update"
    ${box_src_dir}/node_modules/.bin/ejs-cli -f "${script_dir}/start/nginx/appconfig.ejs" \
        -O "{ \"vhost\": \"${arg_admin_fqdn}\", \"adminOrigin\": \"${admin_origin}\", \"endpoint\": \"splash\", \"sourceDir\": \"${SETUP_WEBSITE_DIR}\", \"certFilePath\": \"cert/host.cert\", \"keyFilePath\": \"cert/host.key\", \"xFrameOptions\": \"SAMEORIGIN\", \"robotsTxtQuoted\": null, \"hasIPv6\": false }" > "${PLATFORM_DATA_DIR}/nginx/applications/admin.conf"
fi

if [[ "${arg_retire_reason}" == "migrate" ]]; then
    echo "{ \"migrate\": { \"percent\": \"10\", \"message\": \"Migrating cloudron. This could take up to 15 minutes.\", \"info\": ${arg_retire_info} }, \"backup\": null, \"apiServerOrigin\": \"${arg_api_server_origin}\" }" > "${SETUP_WEBSITE_DIR}/progress.json"
else
    echo '{ "update": { "percent": "10", "message": "Updating cloudron software" }, "backup": null }' > "${SETUP_WEBSITE_DIR}/progress.json"
fi

nginx -s reload
