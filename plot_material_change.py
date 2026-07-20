"""Draw a publication-ready regional material-change figure from real data."""

from __future__ import annotations

import argparse
from pathlib import Path

COLORS = {
    "ink": "#243832",
    "muted": "#718079",
    "line": "#19715c",
    "fill": "#dcece6",
    "region": "#d8a13d",
    "map": "#e7ece9",
    "border": "#ffffff",
    "grid": "#dfe5e1",
}


def configure_chinese_font() -> None:
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    candidates = [
        "Microsoft YaHei",
        "SimHei",
        "Noto Sans CJK SC",
        "Source Han Sans CN",
        "Arial Unicode MS",
    ]
    installed = {item.name for item in font_manager.fontManager.ttflist}
    plt.rcParams["font.sans-serif"] = [
        *(name for name in candidates if name in installed),
        "DejaVu Sans",
    ]
    plt.rcParams["axes.unicode_minus"] = False


def read_table(path: Path):
    import pandas as pd

    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    raise ValueError("数据文件仅支持 CSV、XLSX 或 XLS 格式。")


def validate_columns(frame, required: list[str], source: str) -> None:
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise ValueError(f"{source}缺少字段：{', '.join(missing)}")


def prepare_series(args: argparse.Namespace):
    import pandas as pd

    frame = read_table(args.data)
    validate_columns(
        frame,
        [args.time_column, args.value_column, args.region_column],
        "数据文件",
    )
    selected = frame.loc[frame[args.region_column].astype(str) == args.region].copy()
    if args.material_column:
        validate_columns(frame, [args.material_column], "数据文件")
        selected = selected.loc[
            selected[args.material_column].astype(str) == args.material
        ]
    if selected.empty:
        raise ValueError(f"数据中没有地区“{args.region}”对应的记录。")

    selected[args.time_column] = pd.to_datetime(selected[args.time_column], errors="raise")
    selected[args.value_column] = pd.to_numeric(selected[args.value_column], errors="raise")
    selected = selected.sort_values(args.time_column)
    if selected[args.time_column].duplicated().any():
        raise ValueError("筛选后的时间字段存在重复值，请先明确聚合口径。")
    return selected


def prepare_map(args: argparse.Namespace):
    import geopandas as gpd

    areas = gpd.read_file(args.geo)
    validate_columns(areas, [args.geo_name_column], "边界文件")
    selected = areas.loc[areas[args.geo_name_column].astype(str) == args.region]
    if selected.empty:
        raise ValueError(
            f"边界文件的“{args.geo_name_column}”字段中没有“{args.region}”。"
        )
    return areas, selected


def draw(args: argparse.Namespace) -> None:
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator

    series = prepare_series(args)
    areas, selected_area = prepare_map(args)
    configure_chinese_font()

    figure = plt.figure(figsize=(14, 7.6), facecolor="#f5f7f5", layout="constrained")
    grid = figure.add_gridspec(1, 2, width_ratios=(0.82, 1.55), wspace=0.08)
    map_axis = figure.add_subplot(grid[0, 0])
    trend_axis = figure.add_subplot(grid[0, 1])

    for axis in (map_axis, trend_axis):
        axis.set_facecolor("white")

    areas.plot(
        ax=map_axis,
        color=COLORS["map"],
        edgecolor=COLORS["border"],
        linewidth=0.7,
    )
    selected_area.plot(
        ax=map_axis,
        color=COLORS["region"],
        edgecolor="white",
        linewidth=1.2,
    )
    map_axis.set_title("地区位置", loc="left", color=COLORS["ink"], fontsize=14, pad=14)
    map_axis.text(
        0.02,
        0.02,
        args.region,
        transform=map_axis.transAxes,
        color=COLORS["ink"],
        fontsize=12,
        fontweight="bold",
        bbox={"facecolor": "white", "edgecolor": "none", "pad": 5},
    )
    map_axis.set_axis_off()

    x = series[args.time_column]
    y = series[args.value_column]
    trend_axis.plot(x, y, color=COLORS["line"], linewidth=2.6, zorder=3)
    trend_axis.scatter(
        x,
        y,
        s=34,
        facecolor="white",
        edgecolor=COLORS["line"],
        linewidth=1.6,
        zorder=4,
    )
    trend_axis.fill_between(x, y, y.min(), color=COLORS["fill"], alpha=0.55, zorder=1)
    trend_axis.set_title("时间变化", loc="left", color=COLORS["ink"], fontsize=14, pad=14)
    trend_axis.set_xlabel("时间", color=COLORS["muted"], labelpad=10)
    trend_axis.set_ylabel(
        f"{args.material}（{args.unit}）" if args.unit else args.material,
        color=COLORS["muted"],
        labelpad=12,
    )
    trend_axis.grid(axis="y", color=COLORS["grid"], linewidth=0.8)
    trend_axis.yaxis.set_major_locator(MaxNLocator(nbins=6))
    trend_axis.spines[["top", "right", "left"]].set_visible(False)
    trend_axis.spines["bottom"].set_color(COLORS["grid"])
    trend_axis.tick_params(axis="both", colors=COLORS["muted"], length=0, pad=8)
    trend_axis.margins(x=0.035, y=0.13)

    figure.suptitle(
        f"{args.region}{args.material}变化",
        x=0.04,
        ha="left",
        color=COLORS["ink"],
        fontsize=23,
        fontweight="bold",
    )
    subtitle = args.source or ""
    if subtitle:
        figure.text(0.04, 0.925, f"数据来源：{subtitle}", color=COLORS["muted"], fontsize=9)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(args.output, dpi=args.dpi, bbox_inches="tight", facecolor=figure.get_facecolor())
    plt.close(figure)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="绘制地区物质随时间变化图。")
    parser.add_argument("--data", type=Path, required=True, help="CSV 或 Excel 数据文件")
    parser.add_argument("--geo", type=Path, required=True, help="GeoJSON 或 Shapefile 边界文件")
    parser.add_argument("--region", required=True, help="要展示的地区名称")
    parser.add_argument("--material", required=True, help="物质名称")
    parser.add_argument("--unit", default="", help="数值单位")
    parser.add_argument("--source", default="", help="图中标注的数据来源")
    parser.add_argument("--time-column", default="time", help="时间字段名")
    parser.add_argument("--value-column", default="value", help="数值字段名")
    parser.add_argument("--region-column", default="region", help="数据中的地区字段名")
    parser.add_argument("--material-column", default="material", help="数据中的物质字段名；传空字符串可关闭筛选")
    parser.add_argument("--geo-name-column", default="name", help="边界文件中的地区名称字段")
    parser.add_argument("--output", type=Path, default=Path("output/figure.png"), help="输出 PNG、PDF 或 SVG 文件")
    parser.add_argument("--dpi", type=int, default=300, help="位图分辨率")
    return parser.parse_args()


if __name__ == "__main__":
    draw(parse_args())
