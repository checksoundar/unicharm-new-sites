# Install — Site Analysis Dashboard skill

This is a Claude Code **skill** (a folder, not a single binary).

## Install
Unzip so the folder lands at one of these locations:
- Project scope:  `<your-repo>/.claude/skills/site-analysis-dashboard/`
- User scope:     `~/.claude/skills/site-analysis-dashboard/`

```bash
unzip site-analysis-dashboard.skill.zip -d <your-repo>/.claude/skills/
```

Restart / reload the session so the skill registers, then invoke it by name,
or run the pipeline directly:

```bash
bash <your-repo>/.claude/skills/site-analysis-dashboard/scripts/run-analysis.sh <catalogFolder>
```

See `SKILL.md` for full usage, prerequisites (headless Chromium via playwright-core)
and the `templates/config.example.json` configuration.
