#!/bin/sh
set -u

umask 077
output=$1
status_file=$2
cwd=$3
COMMAND_SCRIPT=$4
export COMMAND_SCRIPT

if ! cd "$cwd" 2>"$output"; then
    status=125
    printf '%s\n' "$status" >"$status_file"
    exit "$status"
fi

# Allocate a PTY and record output only. In particular, do not log typed passwords.
# The fixed command keeps user arguments out of script's metadata header.
script --quiet --flush --return --echo never --log-out "$output" --command 'sh "$COMMAND_SCRIPT"'
status=$?
printf '%s\n' "$status" >"$status_file"
exit "$status"
