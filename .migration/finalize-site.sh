#!/bin/bash
# finalize-site.sh <catalogFolder> — re-run the post-classification stages after block-mapping.json
# (and/or config.familyDescriptions) is written: consolidate → layouts/integrations → template shots
# → coverage → supplementary data → dashboard. No re-rendering of pages.
CF="${1:?catalog folder}"
S=/backups/checksoundar/unicharm-new-sites/repo/.claude/skills/site-analysis-dashboard/scripts
export NODE_PATH=/home/node/.excat-marketplaces/excat-extended/stardust/node_modules
export SCOPE_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ORIGIN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CF/config.json')).siteOrigin)")
set -e
node $S/consolidate-aem-components.js "$CF" > "$CF/consolidate.log"
node $S/cluster-layouts.js "$CF" > /dev/null
node $S/consolidate-aem-components.js "$CF" > "$CF/consolidate.log"
[ "${SHOTS:-1}" = "1" ] && { rm -f "$CF/shots.json"; node $S/capture-shots.js "$CF" > "$CF/shots.log" 2>&1 || true; }
node $S/compute-inspection.js "$CF" > /dev/null 2>&1 || true
node $S/consolidate-backend.js "$CF" > /dev/null 2>&1 || true
node $S/compute-data.js "$CF" "$ORIGIN" > /dev/null
node $S/build-dashboard.js "$CF" | head -1
tail -n +2 "$CF/consolidate.log" | grep -v '^layout families' | awk '{print "  " $0}' | cut -c1-150
