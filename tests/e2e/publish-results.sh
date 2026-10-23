#!/usr/bin/env bash
# Pushes a results folder to an orphan branch so it can be read with plain git.
set -euo pipefail
DIR=$1; BRANCH=$2
cd "$DIR"
echo "run: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" > RUN.txt
echo "sha: ${GITHUB_SHA}" >> RUN.txt
git init -q
git checkout -q -b "$BRANCH"
git add -A
git -c user.name="ci" -c user.email="ci@users.noreply.github.com" commit -q -m "CI results for ${GITHUB_SHA::7} (run ${GITHUB_RUN_ID})"
git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"
