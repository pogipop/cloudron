#!/bin/bash

set -eu -o pipefail

assertNotEmpty() {
    : "${!1:? "$1 is not set."}"
}

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
export JSON="${SOURCE_DIR}/node_modules/.bin/json"

IMAGE_ID="ami-5aee2235" # ubuntu 16.04 eu-central-1
INSTANCE_TYPE="t2.micro"
SECURITY_GROUP="sg-19f5a770" # everything open on eu-central-1
BLOCK_DEVICE="DeviceName=/dev/sda1,Ebs={VolumeSize=20,DeleteOnTermination=true,VolumeType=gp2}"
SSH_KEY_NAME="id_rsa_yellowtent"

revision=$(git rev-parse HEAD)
ami_name=""
server_id=""
server_ip=""
destroy_server="yes"
deploy_env="prod"

args=$(getopt -o "" -l "revision:,name:,no-destroy,env:" -n "$0" -- "$@")
eval set -- "${args}"

while true; do
    case "$1" in
    --env) deploy_env="$2"; shift 2;;
    --revision) revision="$2"; shift 2;;
    --name) ami_name="$2"; shift 2;;
    --no-destroy) destroy_server="no"; shift 2;;
    --) break;;
    *) echo "Unknown option $1"; exit 1;;
    esac
done

export AWS_DEFAULT_REGION="eu-central-1"    # we have to use us-east-1 to publish

# TODO fix this
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY}"
export AWS_SECRET_ACCESS_KEY="${AWS_ACCESS_SECRET}"

echo "=> Creating AMI"

readonly ssh_keys="${HOME}/.ssh/id_rsa_yellowtent"
readonly SSH="ssh -o IdentitiesOnly=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -i ${ssh_keys}"

if [[ ! -f "${ssh_keys}" ]]; then
    echo "caas ssh key is missing at ${ssh_keys} (pick it up from secrets repo)"
    exit 1
fi

function get_pretty_revision() {
    local git_rev="$1"
    local sha1=$(git rev-parse --short "${git_rev}" 2>/dev/null)

    echo "${sha1}"
}

now=$(date "+%Y-%m-%d-%H%M%S")
pretty_revision=$(get_pretty_revision "${revision}")

if [[ -z "${ami_name}" ]]; then
    # if you change this, change the regexp is appstore/janitor.js
    ami_name="box-${deploy_env}-${pretty_revision}-${now}" # remove slashes
fi

echo "=> Create EC2 instance"
id=$(aws ec2 run-instances --image-id "${IMAGE_ID}" --instance-type "${INSTANCE_TYPE}" --security-group-ids "${SECURITY_GROUP}" --block-device-mappings "${BLOCK_DEVICE}" --key-name "${SSH_KEY_NAME}"\
    | $JSON Instances \
    | $JSON 0.InstanceId)

[[ -z "$id" ]] && exit 1
echo "Instance created with ID $id"

echo "=> Waiting for instance to get a public IP"
while true; do
    server_ip=$(aws ec2 describe-instances --instance-ids ${id} \
        | $JSON Reservations.0.Instances \
        | $JSON 0.PublicIpAddress)

    if [[ ! -z "${server_ip}" ]]; then
        echo ""
        break
    fi

    echo -n "."
    sleep 1
done

echo "Got public IP ${server_ip}"

echo "=> Waiting for ssh connection"
while true; do
    echo -n "."

    if $SSH ubuntu@${server_ip} echo "hello"; then
        echo ""
        break
    fi

    sleep 5
done

echo "=> Fetching cloudron-setup"
while true; do

    if $SSH ubuntu@${server_ip} wget "https://cloudron.io/cloudron-setup" -O "cloudron-setup"; then
        echo ""
        break
    fi

    echo -n "."
    sleep 5
done

echo "=> Running cloudron-setup"
$SSH ubuntu@${server_ip} sudo /bin/bash "cloudron-setup" --env "${deploy_env}" --provider "ec2"

echo "=> Creating AMI"
image_id=$(aws ec2 create-image --instance-id "${id}" --name "${ami_name}" | $JSON ImageId)
[[ -z "$id" ]] && exit 1
echo "Creating AMI with Id ${image_id}"

echo "=> Waiting for AMI to be created"
while true; do
    state=$(aws ec2 describe-images --image-ids ${image_id} \
        | $JSON Images \
        | $JSON 0.State)

    if [[ "${state}" == "available" ]]; then
        echo ""
        break
    fi

    echo -n "."
    sleep 5
done

if [[ "${destroy_server}" == "yes" ]]; then
    echo "=> Deleting EC2 instance"

    while true; do
        state=$(aws ec2 terminate-instances --instance-id "${id}" \
            | $JSON TerminatingInstances \
            | $JSON 0.CurrentState.Name)

        if [[ "${state}" == "shutting-down" ]]; then
            echo ""
            break
        fi

        echo -n "."
        sleep 5
    done
fi

echo ""
echo "Done."
echo ""
echo "New AMI is: ${image_id}"
echo ""
