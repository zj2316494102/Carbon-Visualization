"""Unified command-line interface."""

from __future__ import annotations

import argparse
from pathlib import Path

from . import PROJECT_ROOT


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="区域时空动态观测项目管理工具。")
    commands = parser.add_subparsers(dest="command", required=True)

    export = commands.add_parser("export-web", help="根据 catalog 生成前端数据包")
    export.add_argument("--catalog", type=Path, default=PROJECT_ROOT / "config/data_catalog.json")
    export.add_argument("--output", type=Path, default=PROJECT_ROOT / "web/data/dataset.js")

    demo = commands.add_parser("build-demo", help="生成老师汇报离线单文件")
    demo.add_argument("--source", type=Path, default=PROJECT_ROOT / "web")
    demo.add_argument("--output", type=Path, default=PROJECT_ROOT / "teacher_demo/carbon_visualization_demo.html")

    animate = commands.add_parser("animate", help="生成地区物质变化 GIF 或 MP4")
    animate.add_argument("--config", type=Path, required=True)
    animate.add_argument("--frequency", choices=("day", "month", "year"), required=True)
    animate.add_argument("--output", type=Path, required=True)

    plot = commands.add_parser("plot", help="生成地区物质变化静态图")
    plot.add_argument("--data", type=Path, required=True)
    plot.add_argument("--geo", type=Path, required=True)
    plot.add_argument("--region", required=True)
    plot.add_argument("--material", required=True)
    plot.add_argument("--unit", default="")
    plot.add_argument("--source", default="")
    plot.add_argument("--time-column", default="time")
    plot.add_argument("--value-column", default="value")
    plot.add_argument("--region-column", default="region")
    plot.add_argument("--material-column", default="material")
    plot.add_argument("--geo-name-column", default="name")
    plot.add_argument("--output", type=Path, default=PROJECT_ROOT / "output/figure.png")
    plot.add_argument("--dpi", type=int, default=300)
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    if arguments.command == "export-web":
        from .exporter import export
        export(arguments.catalog, arguments.output)
    elif arguments.command == "build-demo":
        from .demo import build
        build(arguments.source, arguments.output)
    elif arguments.command == "animate":
        from .animation import load_config, make_animation
        make_animation(load_config(arguments.config), arguments.frequency, arguments.output, PROJECT_ROOT)
    else:
        from .static_plot import draw
        draw(arguments)
