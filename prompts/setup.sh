#!/usr/bin/env bash
# Agent runs this once at session start. Sets up PATH + aliases.
export PATH="/home/acorn221/projects/cws-scraper/dynamic-analysis:$PATH"
alias da="node /home/acorn221/projects/cws-scraper/dynamic-analysis/dist/cli.js"
echo "da ready"
