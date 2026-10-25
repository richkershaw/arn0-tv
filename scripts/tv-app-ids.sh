#!/bin/sh
# Lists which well-known store apps are installed on the TV, with the numeric IDs that the TV's
# REST API (and Home Assistant's SamsungTV Smart app_list) understands. Run from a computer the
# TV has already allowed (Device Connection Manager), e.g.:  sh scripts/tv-app-ids.sh <tv-ip>
# IDs that are not installed are silently skipped; add your own to CANDIDATES to test them.
set -u
TV="${1:?usage: tv-app-ids.sh <tv-ip>}"
CANDIDATES="
111299001912 3201907018807 11101200001 3201910019365 3201901017640 3201601007250
3201602007865 3201608010191 3201612011418 121299000089 3201703012079 3201710015037
3201807016597 3201606009684 3201512006963 3201603008746 3201710014981 3201909019175
3202203026841 3201906018693 3201802015379 3201804016046 3202010022079 3201908019041
3201710015016 3201611010983 3201505002690 111477000722 3201601007230 3201707014489
"
printf '%-16s %-8s %-8s %s\n' ID RUNNING VISIBLE NAME
for id in $CANDIDATES; do
    out=$(curl -s -m 3 "http://$TV:8001/api/v2/applications/$id") || continue
    case "$out" in *'"name"'*) ;; *) continue ;; esac
    name=$(printf '%s' "$out" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
    run=$(printf '%s' "$out" | sed -n 's/.*"running":\([a-z]*\).*/\1/p')
    vis=$(printf '%s' "$out" | sed -n 's/.*"visible":\([a-z]*\).*/\1/p')
    printf '%-16s %-8s %-8s %s\n' "$id" "$run" "$vis" "$name"
done
