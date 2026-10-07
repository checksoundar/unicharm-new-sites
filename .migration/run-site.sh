#!/bin/bash
# run-site.sh <catalogFolder> — run the site-analysis-dashboard pipeline for one Fonterra-group site
# (crawl output already present). Full render unless config.renderSample is set.
CF="${1:?catalog folder}"
SKILL=/backups/checksoundar/unicharm-new-sites/repo/.claude/skills/site-analysis-dashboard/scripts
export NODE_PATH=/home/node/.excat-marketplaces/excat-extended/stardust/node_modules
export SCOPE_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
export RENDER_SAMPLE="${RENDER_SAMPLE:-100000}" CONCURRENCY="${CONCURRENCY:-3}" BACKEND_SAMPLE="${BACKEND_SAMPLE:-40}"
[ -f "$CF/urls-all.json" ] || node "$SKILL/build-urls-all.js" "$CF"
CJK=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CF/config.json')).cjk?1:0)") \
  bash "$SKILL/run-analysis.sh" "$CF" > "$CF/pipeline.log" 2>&1
echo "exit=$?" >> "$CF/pipeline.log"
