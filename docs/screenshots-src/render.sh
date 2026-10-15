#!/bin/sh
# Renders every mockup in this folder to ../images/<name>.png at 2x.
# Usage: ./render.sh [name...]   (size comes from the page's <meta name="size">)
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in ${@:-*.html}; do
  name=$(basename "$f" .html)
  size=$(sed -n 's/.*<meta name="size" content="\([0-9]*,[0-9]*\)".*/\1/p' "$name.html")
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --default-background-color=00000000 --window-size="${size:-1200,700}" \
    --screenshot="../images/$name.png" "file://$PWD/$name.html" 2>/dev/null
  echo "rendered $name ($size)"
done
