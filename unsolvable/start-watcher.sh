#!/bin/bash
# Start (or restart) the UNSOLVABLE window watcher as a persistent background process.
# Usage: bash start-watcher.sh
cd "$(dirname "$0")"
if [ -f watcher.pid ]; then
  OLD=$(cat watcher.pid)
  if kill -0 "$OLD" 2>/dev/null; then
    echo "watcher already running (pid $OLD)"
    exit 0
  fi
  echo "removing stale pid $OLD"
  rm -f watcher.pid
fi
nohup node watch.js >> watcher.log 2>&1 &
echo $! > watcher.pid
echo "watcher started pid $(cat watcher.pid)"
sleep 2
tail -3 watcher.log
