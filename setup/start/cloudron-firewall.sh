#!/bin/bash

set -eu -o pipefail

echo "==> Setting up firewall"
iptables -t filter -N CLOUDRON || true
iptables -t filter -F CLOUDRON # empty any existing rules

# NOTE: keep these in sync with src/apps.js validatePortBindings
# allow ssh, http, https, ping, dns
iptables -t filter -I CLOUDRON -m state --state RELATED,ESTABLISHED -j ACCEPT
# ssh is allowed alternately on port 202
iptables -A CLOUDRON -p tcp -m tcp -m multiport --dports 22,25,80,202,443,587,993,4190 -j ACCEPT

iptables -t filter -A CLOUDRON -p icmp --icmp-type echo-request -j ACCEPT
iptables -t filter -A CLOUDRON -p icmp --icmp-type echo-reply -j ACCEPT
iptables -t filter -A CLOUDRON -p udp --sport 53 -j ACCEPT
iptables -t filter -A CLOUDRON -s 172.18.0.0/16 -j ACCEPT # required to accept any connections from apps to our IP:<public port>
iptables -t filter -A CLOUDRON -i lo -j ACCEPT # required for localhost connections (mysql)

# log dropped incoming. keep this at the end of all the rules
iptables -t filter -A CLOUDRON -m limit --limit 2/min -j LOG --log-prefix "IPTables Packet Dropped: " --log-level 7
iptables -t filter -A CLOUDRON -j DROP

if ! iptables -t filter -C INPUT -j CLOUDRON 2>/dev/null; then
    iptables -t filter -I INPUT -j CLOUDRON
fi

# Setup rate limit chain (the recent info is at /proc/net/xt_recent)
iptables -t filter -N CLOUDRON_RATELIMIT || true
iptables -t filter -F CLOUDRON_RATELIMIT # empty any existing rules

# log dropped incoming. keep this at the end of all the rules
iptables -t filter -N CLOUDRON_RATELIMIT_LOG || true
iptables -t filter -F CLOUDRON_RATELIMIT_LOG # empty any existing rules
iptables -t filter -A CLOUDRON_RATELIMIT_LOG -m limit --limit 2/min -j LOG --log-prefix "IPTables RateLimit: " --log-level 7
iptables -t filter -A CLOUDRON_RATELIMIT_LOG -j DROP

# http https
for port in 80 443; do
    iptables -A CLOUDRON_RATELIMIT -p tcp --syn --dport ${port} -m connlimit --connlimit-above 5000 -j CLOUDRON_RATELIMIT_LOG
done

# ssh smtp ssh msa imap sieve
for port in 22 202; do
    iptables -A CLOUDRON_RATELIMIT -p tcp --dport ${port} -m state --state NEW -m recent --set --name "public-${port}"
    iptables -A CLOUDRON_RATELIMIT -p tcp --dport ${port} -m state --state NEW -m recent --update --name "public-${port}" --seconds 10 --hitcount 5 -j CLOUDRON_RATELIMIT_LOG
done

# TODO: move docker platform rules to platform.js so it can be specialized to rate limit only when destination is the mail container

# docker translates (dnat) 25, 587, 993, 4190 in the PREROUTING step
for port in 2525 4190 9993; do
    iptables -A CLOUDRON_RATELIMIT -p tcp --syn ! -s 172.18.0.0/16 -d 172.18.0.0/16 --dport ${port} -m connlimit --connlimit-above 50 -j CLOUDRON_RATELIMIT_LOG
done

# msa, ldap, imap, sieve
for port in 2525 3002 4190 9993; do
    iptables -A CLOUDRON_RATELIMIT -p tcp --syn -s 172.18.0.0/16 -d 172.18.0.0/16 --dport ${port} -m connlimit --connlimit-above 500 -j CLOUDRON_RATELIMIT_LOG
done

# cloudron docker network: mysql postgresql redis mongodb
for port in 3306 5432 6379 27017; do
    iptables -A CLOUDRON_RATELIMIT -p tcp --syn -s 172.18.0.0/16 -d 172.18.0.0/16 --dport ${port} -m connlimit --connlimit-above 5000 -j CLOUDRON_RATELIMIT_LOG
done

# For ssh, http, https
if ! iptables -t filter -C INPUT -j CLOUDRON_RATELIMIT 2>/dev/null; then
    iptables -t filter -I INPUT 1 -j CLOUDRON_RATELIMIT
fi

# For smtp, imap etc routed via docker/nat
# Workaroud issue where Docker insists on adding itself first in FORWARD table
iptables -D FORWARD -j CLOUDRON_RATELIMIT || true
iptables -I FORWARD 1 -j CLOUDRON_RATELIMIT
