#!/usr/bin/env python3
"""Replace image references in markdown with embedded base64 data URLs."""
import base64
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
base_dir = src.parent

text = src.read_text(encoding="utf-8")

def repl(match: re.Match) -> str:
    alt = match.group(1)
    path = match.group(2)
    # Strip file:// prefix if present
    if path.startswith("file://"):
        path = path[len("file://"):]
    path_obj = pathlib.Path(path)
    if not path_obj.is_absolute():
        path_obj = base_dir / path_obj
    if not path_obj.exists():
        print(f"WARN: image not found: {path_obj}", file=sys.stderr)
        return match.group(0)
    data = path_obj.read_bytes()
    suffix = path_obj.suffix.lower().lstrip(".")
    if suffix in ("jpg", "jpeg"):
        mime = "image/jpeg"
    elif suffix == "png":
        mime = "image/png"
    elif suffix == "gif":
        mime = "image/gif"
    elif suffix == "webp":
        mime = "image/webp"
    else:
        mime = "application/octet-stream"
    b64 = base64.b64encode(data).decode("ascii")
    return f"![{alt}](data:{mime};base64,{b64})"

# Match ![alt](path) markdown image syntax
out = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl, text)
dst.write_text(out, encoding="utf-8")
print(f"Wrote {dst} ({len(out)} chars)")
