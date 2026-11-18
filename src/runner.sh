#!/bin/sh
set -u

umask 077
output=$1
status_file=$2
cwd=$3
COMMAND_SCRIPT=$4
COMMAND_PID_FILE=$5
collector=$6
capture_limit=$7
export COMMAND_SCRIPT COMMAND_PID_FILE
channel=$output.fifo

if ! cd "$cwd" 2>"$output"; then
    status=125
    printf '%s\n' "$status" >"$status_file"
    exit "$status"
fi

rm -f "$channel"
mkfifo "$channel" || exit 124
node "$collector" "$output" "$capture_limit" <"$channel" &
collector_pid=$!

# Disable echo initially, but the child can re-enable it; echoed input is captured.
# The fixed command keeps user arguments out of script's metadata header.
script --quiet --flush --return --echo never /dev/null \
    --command 'sh "$COMMAND_SCRIPT"' >"$channel" 2>&1
status=$?

wait "$collector_pid"
collector_status=$?
rm -f "$channel"
if [ "$collector_status" -ne 0 ] && [ "$status" -eq 0 ]; then
    status=124
fi
printf '%s\n' "$status" >"$status_file"
exit "$status"
