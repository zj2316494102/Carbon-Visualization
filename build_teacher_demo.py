"""Build a self-contained offline HTML demonstration for external sharing."""

from __future__ import annotations

import argparse
from pathlib import Path


def build(source_dir: Path, output: Path) -> None:
    html = (source_dir / "index.html").read_text(encoding="utf-8")
    css = (source_dir / "styles.css").read_text(encoding="utf-8")
    dataset = (source_dir / "data" / "dataset.js").read_text(encoding="utf-8")
    app = (source_dir / "app.js").read_text(encoding="utf-8")

    stylesheet = '<link rel="stylesheet" href="styles.css?v=20260720-3" />'
    data_script = '<script src="data/dataset.js?v=20260720-3"></script>'
    app_script = '<script src="app.js?v=20260720-3"></script>'
    if stylesheet not in html or data_script not in html or app_script not in html:
        raise ValueError("前端入口资源标记已变化，请更新打包脚本。")

    html = html.replace(stylesheet, f"<style>\n{css}\n</style>")
    html = html.replace(data_script, f"<script>\n{dataset}\n</script>")
    html = html.replace(app_script, f"<script>\n{app}\n</script>")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成老师汇报使用的离线单文件页面。")
    parser.add_argument("--source", type=Path, default=Path("web"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("teacher_demo/carbon_visualization_demo.html"),
    )
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    build(arguments.source, arguments.output)
