"""Build a self-contained offline HTML demonstration for external sharing."""

from __future__ import annotations

import re
from pathlib import Path


def build(source_dir: Path, output: Path) -> None:
    html = (source_dir / "index.html").read_text(encoding="utf-8")
    css = (source_dir / "styles.css").read_text(encoding="utf-8")
    dataset = (source_dir / "data" / "dataset.js").read_text(encoding="utf-8")
    color_scale = (source_dir / "color-scale.js").read_text(encoding="utf-8")
    app = (source_dir / "app.js").read_text(encoding="utf-8")

    replacements = [
        (r'<link rel="stylesheet" href="styles\.css\?v=[^"]+"\s*/>', f"<style>\n{css}\n</style>"),
        (r'<script src="data/dataset\.js\?v=[^"]+"></script>', f"<script>\n{dataset}\n</script>"),
        (r'<script src="color-scale\.js\?v=[^"]+"></script>', f"<script>\n{color_scale}\n</script>"),
        (r'<script src="app\.js\?v=[^"]+"></script>', f"<script>\n{app}\n</script>"),
    ]
    for pattern, replacement in replacements:
        html, count = re.subn(pattern, lambda _: replacement, html, count=1)
        if count != 1:
            raise ValueError(f"前端入口资源标记未匹配：{pattern}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
