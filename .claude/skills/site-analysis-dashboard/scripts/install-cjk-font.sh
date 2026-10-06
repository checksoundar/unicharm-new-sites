#!/bin/bash
# install-cjk-font.sh — install & verify Noto Sans CJK JP so headless screenshots
# render Japanese/Chinese/Korean text (no "tofu" boxes). Backs the font up into the
# catalog folder so it can be restored instantly after an environment reset.
# Usage: bash install-cjk-font.sh <catalogFolder>
set +H 2>/dev/null || true
CF="${1:-.}"; BK="$CF/.fonts"; DEST=~/.local/share/fonts
mkdir -p "$DEST" "$BK"

# fast path: restore from catalog backup if present
if ls "$BK"/NotoSansCJKjp-*.otf >/dev/null 2>&1; then
  cp "$BK"/NotoSansCJKjp-*.otf "$DEST"/ && fc-cache -f "$DEST" >/dev/null 2>&1
fi
# download if still not resolving
if ! fc-match 'sans-serif:lang=ja' | grep -qi noto; then
  for w in Regular Bold; do
    curl -sSL --max-time 120 -o "$DEST/NotoSansCJKjp-$w.otf" \
      "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-$w.otf"
  done
  cp "$DEST"/NotoSansCJKjp-*.otf "$BK"/ 2>/dev/null   # back up for next time
  fc-cache -f "$DEST" >/dev/null 2>&1
fi
echo "CJK font: $(fc-match 'sans-serif:lang=ja')"
