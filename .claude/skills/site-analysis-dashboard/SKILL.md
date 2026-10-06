---
name: Site Analysis Dashboard
description: Run an exhaustive site analysis of any website and produce a self-contained, multi-section interactive HTML dashboard to scope an AEM Edge Delivery Services migration. Crawls every page, groups URLs by pattern, renders + structurally fingerprints pages into layout families, catalogs block variants (Cards, Media, Table, Form, Embed, Hero, List, Text, plus Carousel/Accordion/Tabs/Video detected by structure+ARIA and an Unknown/Custom group) with cropped screenshots + source URLs, scans front-end third-party integrations (site-wide, per-template, per-block-type heatmaps), infers PROBABLE BACKEND integrations from runtime XHR/fetch API calls, categorises URL coverage (fully-inspected / sampled / excluded per pattern), builds pictorial methodology step-diagrams, and assembles a dashboard with Overview, Methodology, Page Templates (full-page popups), Blocks & Components galleries, Human-in-the-loop Review, Integrations (front-end + backend), URL Coverage, Site Structure, Linked Documents and Recommendations. Handles multi-locale sites and installs a CJK font so Japanese/Chinese/Korean text renders correctly in screenshots. Use when asked to "analyze a site", "site analysis report/dashboard", "scope a migration", "discover pages and layouts", "catalog blocks", or "build a migration console" for a URL.
---

# Site Analysis Dashboard

Turns a live website into a single self-contained interactive HTML dashboard for scoping an
AEM Edge Delivery Services migration. This is the generalized pipeline first built for the
Marubeni.com analysis.

## When to use

- "Do a full site analysis of `https://example.com`"
- "Build a migration console / site-analysis dashboard for this site"
- "Discover all pages and layouts and catalog the blocks"
- "How many page templates / block variants does this site have?"

## What it produces

`reports/<site>-site-analysis-dashboard.html` — one self-contained file (all screenshots
embedded as base64) with these sections:

1. **Overview** — KPIs, key findings, site metrics, method.
2. **Methodology** — how the analysis works, with two pictorial worked-example step-diagrams
   (a recognised block and an Unknown/Custom block, each traced through the detection cascade).
3. **Page Templates** — layout families with page-population estimates, key blocks, sample
   URLs, and a full-page screenshot popup per template.
4. **Blocks & Components** — top-variant table + tabbed galleries per base block type
   (Cards, Media, Table, Form, Embed, Breadcrumbs, Hero, List, Text, **Carousel, Accordion,
   Tabs, Video** and **Unknown/Custom**), every variant with a cropped screenshot, usage
   counts and a clickable source URL. Carousel/Accordion/Tabs/Video are detected by
   **structure + ARIA + behaviour**, not just class-name keywords, so they're still found
   on sites with hashed/obfuscated class names (e.g. Next.js).
5. **Human-in-the-loop Review** — editable canvas pre-seeded from the analysis (per-site
   localStorage key; "Reset to analysis baseline" re-seeds).
6. **Integrations** — (a) detected **front-end** third-party services + **per-template** and
   **per-block-type** coverage heatmaps (Percent/Counts toggles), and (b) **Probable backend
   integrations** inferred from runtime **XHR/fetch API calls** — first-party micro-services
   (identity/auth, consent, telemetry, commerce, GraphQL) vs third-party APIs, colour-coded.
7. **URL Coverage** — full inventory + a **Selected / Sampled / Excluded** categorisation of
   every URL pattern (colour-coded, filterable), showing exactly what was rendered vs skipped
   and why, plus status counts.
8. **Site Structure**, **Linked Documents**, **Recommendations**.

## Prerequisites (environment)

- **Headless Chromium** via the bundled `playwright-core` (ships with the `scrape-webpage`
  skill). The orchestrator auto-discovers it and sets `NODE_PATH`. A Chromium binary must be
  installed (e.g. `/ms-playwright/chromium-*/chrome-linux64/chrome`).
- **Node.js** (uses only built-ins + playwright-core).
- For multi-locale/CJK sites, set `CJK=1` so a Japanese font is installed before screenshots
  (already-running browsers cache fontconfig — the pipeline always launches fresh browsers).

## How to run

1. **Create a working folder and `config.json`.** Put it anywhere durable (NOT `/tmp`, which
   can be wiped mid-run — use a folder inside the repo, e.g. `.migration/<site>-scope/`).
   See `templates/config.example.json`. Minimum fields:

   ```json
   {
     "siteUrl": "https://www.example.com/",
     "siteOrigin": "https://www.example.com",
     "site": "example.com",
     "scope": "Entire domain",
     "catalogFolder": "/abs/path/.migration/example-scope",
     "reportsDir": "/abs/path/reports",
     "templateHtml": "/abs/path/.claude/skills/site-analysis-dashboard/templates/dashboard-template.html",
     "cjk": false
   }
   ```

2. **Run the pipeline** (resumable — safe to re-run after any restart; each stage skips work
   already on disk):

   ```bash
   CJK=1 bash .claude/skills/site-analysis-dashboard/scripts/run-analysis.sh \
     /abs/path/.migration/example-scope
   ```

3. Open the resulting `reports/<site>-site-analysis-dashboard.html` in any browser.

### Scale checkpoint (important for large sites)

The crawl runs to completion and can find thousands of pages. After stage 1 (`urls-all.json`),
**stop and report the page count + per-locale breakdown to the user before mass-rendering**,
and confirm the render scope. To bound work, the render set is built by **semantic URL-template
grouping** (`url-template.js`): every URL is reduced to its structural template (locale-aware,
section-vs-slug, depth-aware — e.g. `/{locale}/{section}/{page}`, `/r/{topic}/{article}`),
recurring templates are sampled (`RENDER_SAMPLE`, default 4), and **every page whose template
is unique/rare at the lowest tree level is rendered in full**. Grouping by *shape* (not literal
section names) is what guarantees a distinctly-structured page is never sampled out — it always
lands in its own group and gets inspected. Attachments/images are always excluded from rendering.

## Pipeline stages (scripts/)

| # | Script | Input → Output |
|---|--------|----------------|
| 1 | `run-analysis.sh` → crawler + `build-urls-all.js` | site → `urls-all.json` |
| 2 | `build-render-set.js` (uses `url-template.js`) | `urls-all.json` → `render-set.json`, `groups.json` (grouped by semantic URL template) |
| 3 | `render-pages.js` | render set → `pages.jsonl` (structural fingerprints) |
| 4 | `cluster-layouts.js` | `pages.jsonl` → `layouts.json` + `integrations.json` (front-end tags) |
| 5 | `capture-blocks.js` | render set → `blocks.jsonl` + `blocks/*.jpg` (incl. tabs/carousel/accordion/video) |
| 6 | `consolidate-blocks.js` | `blocks.jsonl` → `block-catalog.json` |
| 7 | `capture-shots.js` | `layouts.json` → `shots/*.jpg` + `shots.json` |
| 8 | `make-diagrams.js` | `block-catalog.json` → `shots/*-diagram.jpg` |
| 9 | `compute-inspection.js` (uses `url-template.js`) | `urls-all.json` + `render-set.json` → `inspection.json` (per-URL-template coverage: Full/Sampled/Excluded + non-200) |
| 10 | `capture-backend.js` → `consolidate-backend.js` | sampled pages → `backend-pages.jsonl` → `backend.json` |
| 11 | `compute-data.js` | `pages.jsonl`+`blocks.jsonl` → heatmaps, structure, url-groups, integrations |
| 12 | `build-dashboard.js` | all of the above → the dashboard HTML |

`install-cjk-font.sh` installs/verifies the CJK font (with a per-catalog backup for fast
restore after a reset).

Stages 9 (URL-coverage) and 10 (backend) are **optional and additive**: `build-dashboard.js`
renders those sections only if `inspection.json` / `backend.json` exist, so older catalogs
still build. Set `BACKEND_SAMPLE=0` to skip backend capture (e.g. for a quick run).

## AEM Sites mode — tag-pattern block classification (`"blockStrategy": "aem"`)

For AEM Sites sources (pages built from `aem-Grid` / `aem-GridColumn` wrappers) set
`"blockStrategy": "aem"` in `config.json` (optionally `"properties": [{key,label,prefix}]` for
multi-property scopes and `"familyDescriptions"`). Stages 5b–6c then run:

| Script | Output |
|---|---|
| `capture-aem-components.js` | `aem-components.jsonl` (every component instance + normalised tag pattern + tag-path set), `aem-pages.jsonl` (AEM template meta + component sequence) |
| `consolidate-aem-components.js` | `aem-block-inventory.json`; overrides `block-catalog.json`, `blocks.jsonl`, `pages.jsonl`, `layouts.json` (families = property · AEM template) |
| `reshoot-aem-components.js` | clean representative crops (fixed header / cookie bar hidden) |
| `aem-overlay.js` (used by `build-dashboard.js`) | "Block classification — Custom vs Boilerplate" table + galleries per EDS block / custom block |

Tag pattern normalisation: text ignored, inline tags transparent, p/ul/ol/h* runs → `rte`,
identical siblings → `x+`, nested components → `@name`, single-child div chains collapsed,
ARIA role / `aria-expanded` / iframe host kept. Variants = exact hash, then Jaccard ≥ 0.8 on
root-to-leaf tag paths. Classification comes from an **evidence-reviewed `<CF>/block-mapping.json`**
(`{cmp: {eds, category, complexity, rationale, variantRules:[{pattern|style|mod, eds, category, note}]}}`)
with a tag-pattern heuristic fallback; categories: custom, boilerplate, default-content, section,
chrome. Write the mapping after a first consolidate pass, reviewing each variant's pattern,
flags and screenshot. Use `--disable-http2` UA overrides as below if the site has a WAF.

## Key design notes / gotchas

- **Resumability:** `render-pages.js`, `capture-blocks.js` and `capture-backend.js` skip pages
  already recorded; the crawler checkpoints. Keep artifacts in a durable folder so a mid-run
  restart resumes cheaply. (Failed/error records are re-tried; strip them from the `*.jsonl`
  before resuming if a stage was interrupted mid-throttle.)
- **Block classification** cascade: (1) class/id keyword signals → (1b) **structure + ARIA +
  behaviour** signals → (2) semantic HTML → (2b) equal-width sibling rows → (3) content
  heuristics → (4) media-vs-text → **Unknown/Custom fallback**. Tier 1b/2b are what let it
  find **Video** (`<video>` or YouTube/Vimeo/Wistia/Brightcove iframe), **Tabs** (ARIA
  `role=tablist`/`aria-selected`), **Accordion** (`<details>` or `aria-expanded` buttons),
  **Carousel** (horizontal-scroll container with ≥3 slides, or carousel data-attrs) and
  **Columns/Cards** (2–6 similar-width children on one row) on sites whose CSS class names are
  hashed/obfuscated — where keyword-only detection would dump them all into `unknown`. Always
  keep an eye on a large `unknown` bucket: it usually means a class-agnostic signal is missing.
- **URL templates (`url-template.js`)** is the shared, site-agnostic classifier used by BOTH
  `build-render-set.js` and `compute-inspection.js`. It learns locale segments (recurring
  ISO-ish first segments) and structural sections (low-cardinality recurring segments) from the
  crawled set, then reduces each URL to a **shape** template: only the top-level section (or
  `{locale}`, or a well-known hub like `r`) stays literal; deeper structural segments become
  `{section}`/`{topic}`/`{page}` and content ids become `{slug}`/`{id}`. So `/r/payroll/x` and
  `/r/taxes/y` collapse to one template `/r/{topic}/{article}`, while a genuinely unusual shape
  gets its own template. **Guarantee:** because the render set samples per-template and renders
  every unique/rare template in full, a page whose structure is unique at the lowest tree level
  is never sampled out — it's always inspected and always shown in URL Coverage. Special buckets:
  `/fragments/*`, malformed/encoded URLs, attachments.
- **URL coverage (`inspection.json`)** groups every URL by its template (above) and tags each
  group `full` (all rendered), `sampled` (subset rendered), or `excluded` (none rendered), and
  counts non-200s per template. Site-agnostic — no hard-coded section/locale names. The
  dashboard's URL-Coverage section shows a colour-coded, filterable table with Group ID, pattern
  label, URL template, URL count, rendered/skipped, 4xx/5xx and a coverage bar.
- **Backend integrations (`backend.json`)** are inferred from XHR/fetch calls captured on a
  page sample (`BACKEND_SAMPLE`, default 60 — enough to identify site-wide services; per-page
  coverage % is a sample estimate). First-party API calls (same registrable domain as
  `config.siteOrigin`, or a sibling brand CDN) are classified **generically by URL-path
  keywords** (identity/consent/telemetry/commerce/graphql/search/forms); third-party calls
  match a vendor table. Labelled "probable" — based on observed traffic, not server access.
- **`SITE` origin:** `build-dashboard.js` sets the dashboard's link-resolver origin from
  `config.siteOrigin`. If this is wrong, every source link breaks — always set it.
- **Per-site localStorage keys:** the Human Review tool namespaces its storage by `site`, so
  one browser can hold multiple site dashboards without cross-contaminating cached review data.
- **Heap:** the crawler runs with `--max-old-space-size=8192`; large domains otherwise OOM.
- **CJK:** verify `fc-match 'sans-serif:lang=ja'` resolves to Noto before capturing screenshots.
- **WAF / bot protection:** some sites (esp. behind Akamai/Cloudflare) reject headless
  Chromium's default `HeadlessChrome` UA or throttle sustained automated traffic. Symptoms:
  `ERR_HTTP2_PROTOCOL_ERROR` or mass `page.goto` timeouts. Mitigations, in order: the launch
  args already include `--disable-http2`; set **`SCOPE_UA`** to a UA the site accepts (a plain
  `curl/8.5.0` often passes when a spoofed-browser UA does not); drop **`--concurrency` to 1**
  and set **`SCOPE_DELAY`** (ms between pages, honoured by `capture-blocks.js`/`capture-backend.js`)
  to space requests. If a run gets throttled mid-way, let it cool down, strip error records from
  the `*.jsonl`, and resume. Probe reachability with a single headless fetch before resuming.

## Related skills

- `excat-url-discovery` (provides the crawler used in stage 1)
- `scrape-webpage` (provides the bundled `playwright-core` + Chromium)
