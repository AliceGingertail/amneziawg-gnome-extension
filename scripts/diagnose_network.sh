#!/bin/sh
# Capture comparable network snapshots without changing VPN or system settings.
# --probe additionally sends HTTPS requests and performs DNS resolution.
set -u

case "${1-}" in
    '') probe=false ;;
    --probe) probe=true ;;
    *) printf 'Usage: %s [--probe]\n' "$0" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
    printf 'Usage: %s [--probe]\n' "$0" >&2
    exit 2
fi

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1

run() {
    printf '\n>>> '
    printf '%s ' "$@"
    printf '\n'
    if ! command -v "$1" >/dev/null 2>&1; then
        printf 'Command unavailable: %s\n' "$1"
        return
    fi
    timeout 12s "$@" 2>&1
    result=$?
    if [ "$result" -ne 0 ]; then
        printf '[exit status: %s]\n' "$result"
    fi
    return 0
}

printf 'Amnezia network diagnostic snapshot\n'
printf 'Contains local/public IP addresses and network details. Review before sharing.\n'
run date --iso-8601=seconds
run cat /proc/sys/kernel/random/boot_id
run cat /proc/uptime
run systemctl show AmneziaVPN.service -p ActiveState -p SubState -p MainPID \
    -p InvocationID -p ExecMainStartTimestamp -p NRestarts
run ps -C AmneziaVPN-service,amneziawg-go -o pid,ppid,lstart,comm
run gjs -m "$script_dir/service_status.js"
run ip -brief address
run ip -s link show amn0
run ip -4 rule show
run ip -6 rule show
run ip -4 route show table all
run ip -6 route show table all
run ip -4 route get 1.1.1.1
run readlink -f /etc/resolv.conf
run cat /etc/resolv.conf
run systemctl is-active NetworkManager systemd-resolved
run nmcli -f GENERAL.DEVICE,GENERAL.STATE,IP4.GATEWAY,IP4.DNS,IP6.GATEWAY,IP6.DNS device show
run resolvectl status
run journalctl -b --since=-30min --no-pager -n 100 \
    -u AmneziaVPN.service -u NetworkManager.service -u systemd-logind.service \
    -u systemd-suspend.service

if "$probe"; then
    # Ignore proxy settings so the IP probe tests this machine's network route.
    run curl --noproxy '*' -4 --head --silent --show-error \
        --connect-timeout 4 --max-time 6 https://1.1.1.1/
    run getent ahostsv4 example.com
    run curl --noproxy '*' -4 --head --silent --show-error \
        --connect-timeout 4 --max-time 6 https://example.com/
    run ip -s link show amn0
    run gjs -m "$script_dir/service_status.js"
fi
