#!/bin/bash
# run-analysis.sh — end-to-end site-analysis dashboard pipeline.
# Resumable: every stage skips work already on disk. Safe to re-run after a restart.
#
# Usage: bash run-analysis.sh <catalogFolder>
#   catalogFolder must already contain config.json (see SKILL.md).
# Env you may override: CONCURRENCY (default 5), MAX_PAGES (default 9000),
#   RENDER_SAMPLE (default 4), CJK (1 to install a Japanese font first),
#   BACKEND_SAMPLE (default 60; pages sampled for backend-API discovery; 0 to skip),
#   SCOPE_UA (User-Agent for render/capture — set if the site's WAF blocks HeadlessChrome).
set +H 2>/dev/null || true
CF="${1:?usage: run-analysis.sh <catalogFolder>}"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
CONCURRENCY="${CONCURRENCY:-5}"; MAX_PAGES="${MAX_PAGES:-9000}"; RENDER_SAMPLE="${RENDER_SAMPLE:-4}"
BACKEND_SAMPLE="${BACKEND_SAMPLE:-60}"
[ -n "$SCOPE_UA" ] && export SCOPE_UA

# --- resolve playwright-core (bundled with the scrape-webpage skill) + chromium ---
PW_NODE_MODULES="$(dirname "$(find /home/node/.excat-marketplaces -type d -name playwright-core 2>/dev/null | head -1)")"
export NODE_PATH="$PW_NODE_MODULES"
node -e "require('playwright-core')" 2>/dev/null || { echo "❌ playwright-core not found; set NODE_PATH to a node_modules that has it"; exit 1; }

cfg(){ node -e "console.log((JSON.parse(require('fs').readFileSync('$CF/config.json')).$1)||'')"; }
SITE_URL="$(cfg siteUrl)"; SITE_ORIGIN="$(cfg siteOrigin)"
[ -z "$SITE_URL" ] && SITE_URL="$SITE_ORIGIN"

echo "▶ catalog: $CF"; echo "▶ site: $SITE_URL"

# --- optional CJK font (needed for Japanese/Chinese/Korean screenshots) ---
if [ "${CJK:-0}" = "1" ]; then bash "$SKILL_DIR/install-cjk-font.sh" "$CF"; fi

# --- 1. URL discovery (crawl) -> urls-all.json ---
if [ ! -f "$CF/urls-all.json" ]; then
  echo "▶ [1/12] crawling $SITE_URL (this can take a while for large sites)"
  CRAWL="$(find /home/node/.excat-marketplaces -name crawl-site.js -path '*url-discovery*' 2>/dev/null | head -1)"
  NODE_OPTIONS="--max-old-space-size=8192" node "$CRAWL" "$SITE_URL" --max-pages "$MAX_PAGES" --delay 350 --timeout 15000 --max-retries 1 --checkpoint-file "$CF/crawl-checkpoint.json" --logFile "$CF/catalog.log" > "$CF/.crawl.out" 2>>"$CF/catalog.log"
  node "$SKILL_DIR/build-urls-all.js" "$CF"
else echo "▶ [1/12] urls-all.json exists — skip crawl"; fi

# --- 2. render set from URL patterns -> render-set.json, groups.json ---
[ -f "$CF/render-set.json" ] || { echo "▶ [2/12] build render set"; node "$SKILL_DIR/build-render-set.js" "$CF" 2 "$RENDER_SAMPLE"; }

# --- 3. render + fingerprint -> pages.jsonl ---
echo "▶ [3/12] render + fingerprint (resumable)"; node "$SKILL_DIR/render-pages.js" "$CF" --concurrency "$CONCURRENCY"

# --- 4. cluster into layouts -> layouts.json + integrations.json (front-end tags) ---
echo "▶ [4/12] cluster layouts + detect front-end integrations"; node "$SKILL_DIR/cluster-layouts.js" "$CF"

# --- 5. capture block instances -> blocks.jsonl + blocks/ ---
#     Classifies blocks incl. tabs/carousel/accordion/video via structural+ARIA signals
#     (class-agnostic — works on hashed/Next.js markup, not just semantic class names).
echo "▶ [5/12] capture block instances (resumable)"; node "$SKILL_DIR/capture-blocks.js" "$CF" --concurrency "$CONCURRENCY"

# --- 6. consolidate blocks -> block-catalog.json ---
echo "▶ [6/12] consolidate block variants"; node "$SKILL_DIR/consolidate-blocks.js" "$CF"

# --- 5b/6b. AEM Sites sources: component tag-pattern analysis (config.blockStrategy = "aem") ---
#      Walks the real aem-Grid component tree, fingerprints every instance by normalised HTML
#      tag pattern, clusters variants (Jaccard), classifies Custom vs Boilerplate using
#      <CF>/block-mapping.json, and overrides block-catalog/blocks/pages/layouts for the dashboard.
if [ "$(cfg blockStrategy)" = "aem" ]; then
  echo "▶ [5b] AEM component tag-pattern capture (resumable)"; node "$SKILL_DIR/capture-aem-components.js" "$CF" --concurrency "$CONCURRENCY"
  echo "▶ [6b] consolidate + classify AEM components"; node "$SKILL_DIR/consolidate-aem-components.js" "$CF" > "$CF/consolidate.log"
  echo "▶ [6c] re-shoot representative crops (overlays hidden)"; node "$SKILL_DIR/reshoot-aem-components.js" "$CF" --concurrency 3
  node "$SKILL_DIR/cluster-layouts.js" "$CF" > /dev/null   # integrations.json from the AEM-rewritten pages.jsonl
  node "$SKILL_DIR/consolidate-aem-components.js" "$CF" > "$CF/consolidate.log" # AEM template families win over generic layouts
fi

# --- 7. per-layout full-page screenshots -> shots/ + shots.json ---
echo "▶ [7/12] capture template screenshots"; node "$SKILL_DIR/capture-shots.js" "$CF"

# --- 8. methodology diagrams -> shots/*-diagram.jpg ---
echo "▶ [8/12] build methodology diagrams"; node "$SKILL_DIR/make-diagrams.js" "$CF" || echo "  (diagrams optional — continuing)"

# --- 9. URL coverage transparency (Selected / Sampled / Excluded per pattern) -> inspection.json ---
echo "▶ [9/12] compute URL-coverage categorisation"; node "$SKILL_DIR/compute-inspection.js" "$CF" || echo "  (inspection optional — continuing)"

# --- 10. probable BACKEND integrations from XHR/fetch API calls -> backend-pages.jsonl ---
#      Samples pages with a network listener. Set BACKEND_SAMPLE=0 to skip.
if [ "$BACKEND_SAMPLE" != "0" ]; then
  echo "▶ [10/12] capture backend API calls (sample=$BACKEND_SAMPLE, resumable)"
  node "$SKILL_DIR/capture-backend.js" "$CF" --sample "$BACKEND_SAMPLE" --concurrency 1 || echo "  (backend capture optional — continuing)"
  echo "▶ [10b] consolidate backend integrations -> backend.json"
  node "$SKILL_DIR/consolidate-backend.js" "$CF" || echo "  (backend consolidation optional — continuing)"
else echo "▶ [10/12] backend capture skipped (BACKEND_SAMPLE=0)"; fi

# --- 11. compute supplementary data (heatmaps, structure, url-groups) ---
echo "▶ [11/12] compute supplementary data"; node "$SKILL_DIR/compute-data.js" "$CF" "$SITE_ORIGIN"

# --- 12. assemble dashboard (includes URL-coverage + backend sections if present) ---
echo "▶ [12/12] build dashboard"; node "$SKILL_DIR/build-dashboard.js" "$CF"
echo "✅ done."
