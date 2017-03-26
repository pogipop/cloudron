#!/bin/bash

set -eu -o pipefail

readonly USER_HOME="/home/yellowtent"
readonly APPS_SWAP_FILE="/apps.swap"
readonly USER_DATA_FILE="/root/user_data.img"
readonly USER_DATA_DIR="/home/yellowtent/data"

# all sizes are in mb
readonly physical_memory=$(LC_ALL=C free -m | awk '/Mem:/ { print $2 }')
readonly swap_size=$((${physical_memory} > 4096 ? 4096 : ${physical_memory})) # min(RAM, 4GB) if you change this, fix enoughResourcesAvailable() in client.js
readonly app_count=$((${physical_memory} / 200)) # estimated app count
readonly disk_size_bytes=$(LC_ALL=C df --output=size / | tail -n1)
readonly disk_size=$((${disk_size_bytes}/1024))
readonly system_size=10240 # 10 gigs for system libs, apps images, installer, box code, data and tmp
readonly ext4_reserved=$((disk_size * 5 / 100)) # this can be changes using tune2fs -m percent /dev/vda1

echo "Physical memory: ${physical_memory}"
echo "Estimated app count: ${app_count}"
echo "Disk size: ${disk_size}M"

# Allocate swap for general app usage
readonly current_swap=$(swapon --show="name,size" --noheadings --bytes | awk 'BEGIN{s=0}{s+=$2}END{printf "%.0f", s/1024/1024}')
readonly needed_swap_size=$((swap_size - current_swap))
if [[ ${needed_swap_size} -gt 0 ]]; then
    echo "Need more swap of ${needed_swap_size}M"
    # compute size of apps.swap ignoring what is already set
    without_apps_swap=$(swapon --show="name,size" --noheadings --bytes | awk 'BEGIN{s=0}{if ($1!="/apps.swap") s+=$2}END{printf "%.0f", s/1024/1024}')
    apps_swap_size=$((swap_size - without_apps_swap))
    echo "Creating Apps swap file of size ${apps_swap_size}M"
    if [[ -f "${APPS_SWAP_FILE}" ]]; then
        echo "Swapping off before resizing swap"
        swapoff "${APPS_SWAP_FILE}" || true
    fi
    fallocate -l "${apps_swap_size}m" "${APPS_SWAP_FILE}"
    chmod 600 "${APPS_SWAP_FILE}"
    mkswap "${APPS_SWAP_FILE}"
    swapon "${APPS_SWAP_FILE}"
    if ! grep -q "${APPS_SWAP_FILE}" /etc/fstab; then
        echo "Adding swap to fstab"
        echo "${APPS_SWAP_FILE}  none  swap  sw  0 0" >> /etc/fstab
    fi
else
    echo "Swap requirements already met"
fi

# see start.sh for the initial default size of 8gb. On small disks the calculation might be lower than 8gb resulting in a failure to resize here.
echo "Resizing data volume"
home_data_size=$((disk_size - system_size - swap_size - ext4_reserved))
echo "Resizing up btrfs user data to size ${home_data_size}M"
umount "${USER_DATA_DIR}" || true
# Do not preallocate (non-sparse). Doing so overallocates for data too much in advance and causes problems when using many apps with smaller data
# fallocate -l "${home_data_size}m" "${USER_DATA_FILE}" # does not overwrite existing data
truncate -s "${home_data_size}m" "${USER_DATA_FILE}" # this will shrink it if the file had existed. this is useful when running this script on a live system
mount -t btrfs -o loop,nosuid "${USER_DATA_FILE}" ${USER_DATA_DIR}
btrfs filesystem resize max "${USER_DATA_DIR}"
