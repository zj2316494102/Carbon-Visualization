"""Create spatial and temporal material-change animations from real records."""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path


FREQUENCY_ORDER = {"day": 0, "month": 1, "year": 2}


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        config = json.load(stream)
    return config


def resolve_path(project_root: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else project_root / path


def load_data(config: dict, project_root: Path):
    import geopandas as gpd
    import pandas as pd

    data_config = config["data"]
    pattern = str(resolve_path(project_root, data_config["files"]))
    paths = sorted(Path(path) for path in glob.glob(pattern))
    if not paths:
        raise FileNotFoundError(f"未找到数据文件：{pattern}")

    frames = [pd.read_csv(path) for path in paths]
    records = pd.concat(frames, ignore_index=True)
    geometry = gpd.read_file(resolve_path(project_root, data_config["geometry"]))

    required = {
        data_config["join_column"],
        data_config["period_column"],
        config["substance"]["value_column"],
    }
    missing = required - set(records.columns)
    if missing:
        raise ValueError(f"数据缺少字段：{', '.join(sorted(missing))}")
    if data_config["join_column"] not in geometry.columns:
        raise ValueError(f"边界数据缺少连接字段：{data_config['join_column']}")

    period_column = data_config["period_column"]
    records["_time"] = pd.to_datetime(
        records[period_column].astype(str),
        format=data_config["period_format"],
        errors="raise",
    )
    records["_value"] = pd.to_numeric(
        records[config["substance"]["value_column"]], errors="raise"
    )
    if records.duplicated([data_config["join_column"], "_time"]).any():
        raise ValueError("同一网格和时间存在重复记录，请先确认聚合口径。")
    return records, geometry


def select_region(records, geometry, config: dict, project_root: Path):
    import geopandas as gpd

    region = config["region"]
    join_column = config["data"]["join_column"]
    mode = region.get("mode", "all")
    if mode == "all":
        return records, geometry
    if mode == "cells":
        cells = set(region.get("cell_ids", []))
        if not cells:
            raise ValueError("region.mode 为 cells 时必须提供 cell_ids。")
        return (
            records.loc[records[join_column].isin(cells)].copy(),
            geometry.loc[geometry[join_column].isin(cells)].copy(),
        )
    if mode == "boundary":
        boundary_path = resolve_path(project_root, region["boundary"])
        boundary = gpd.read_file(boundary_path)
        if boundary.crs != geometry.crs:
            boundary = boundary.to_crs(geometry.crs)
        mask = geometry.geometry.centroid.within(boundary.geometry.union_all())
        selected_geometry = geometry.loc[mask].copy()
        selected_cells = set(selected_geometry[join_column])
        return (
            records.loc[records[join_column].isin(selected_cells)].copy(),
            selected_geometry,
        )
    raise ValueError(f"未知地区选择模式：{mode}")


def aggregate(records, frequency: str, config: dict):
    import pandas as pd

    source_frequency = config["data"]["source_frequency"]
    if FREQUENCY_ORDER[frequency] < FREQUENCY_ORDER[source_frequency]:
        raise ValueError(
            f"源数据粒度为 {source_frequency}，不能生成 {frequency} 动画。"
            "请提供相应时间粒度的真实数据。"
        )

    join_column = config["data"]["join_column"]
    aggregation = config["substance"].get("aggregation", "sum")
    if frequency == "day":
        records["_frame"] = records["_time"].dt.to_period("D").dt.to_timestamp()
    elif frequency == "month":
        records["_frame"] = records["_time"].dt.to_period("M").dt.to_timestamp()
    else:
        records["_frame"] = records["_time"].dt.to_period("Y").dt.to_timestamp()

    grouped = (
        records.groupby([join_column, "_frame"], as_index=False)["_value"]
        .agg(aggregation)
        .sort_values("_frame")
    )
    if grouped.empty:
        raise ValueError("地区筛选后没有可用于绘图的数据。")
    grouped["_display_value"] = (
        grouped["_value"] * config["substance"].get("display_factor", 1)
    )
    totals = grouped.groupby("_frame", as_index=False)["_display_value"].sum()
    return grouped, totals


def make_animation(config: dict, frequency: str, output: Path, project_root: Path) -> None:
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib import animation, colors
    from matplotlib.cm import ScalarMappable
    from matplotlib.ticker import MaxNLocator

    from plot_material_change import configure_chinese_font

    records, geometry = load_data(config, project_root)
    records, geometry = select_region(records, geometry, config, project_root)
    grouped, totals = aggregate(records, frequency, config)
    configure_chinese_font()

    join_column = config["data"]["join_column"]
    visual = config["visual"]
    substance = config["substance"]
    frame_times = list(totals["_frame"])
    values = grouped["_display_value"].to_numpy()
    vmax = float(np.quantile(values, visual.get("upper_quantile", 1)))
    vmax = vmax if vmax > 0 else 1.0
    norm = colors.Normalize(vmin=0, vmax=vmax, clip=True)
    cmap = plt.get_cmap(visual.get("cmap", "YlOrRd"))

    figure = plt.figure(figsize=(13.5, 7.4), facecolor="#f4f6f3")
    grid = figure.add_gridspec(
        2, 2, width_ratios=(1.25, 1), height_ratios=(1, 0.07),
        left=0.055, right=0.955, top=0.86, bottom=0.09, wspace=0.16, hspace=0.12,
    )
    map_axis = figure.add_subplot(grid[0, 0])
    trend_axis = figure.add_subplot(grid[0, 1])
    color_axis = figure.add_subplot(grid[1, 0])
    figure.suptitle(
        f"{config['region']['name']} · {substance['name']}",
        x=0.055, ha="left", fontsize=22, fontweight="bold", color="#243832",
    )
    figure.text(
        0.055, 0.89,
        f"{config['dataset_name']}  |  {frequency_label(frequency)}变化",
        color="#718079", fontsize=10,
    )
    ScalarMappable(norm=norm, cmap=cmap).set_array([])
    colorbar = figure.colorbar(
        ScalarMappable(norm=norm, cmap=cmap), cax=color_axis, orientation="horizontal"
    )
    colorbar.set_label(f"网格排放量（{substance['display_unit']}）", color="#66756e")
    colorbar.outline.set_visible(False)
    color_axis.tick_params(colors="#718079", length=0, labelsize=8)

    def update(frame_index: int):
        current_time = frame_times[frame_index]
        current = grouped.loc[grouped["_frame"] == current_time, [join_column, "_display_value"]]
        layer = geometry.merge(current, on=join_column, how="left")
        layer["_display_value"] = layer["_display_value"].fillna(0)

        map_axis.clear()
        trend_axis.clear()
        map_axis.set_facecolor("#ffffff")
        trend_axis.set_facecolor("#ffffff")
        layer.plot(
            ax=map_axis, column="_display_value", cmap=cmap, norm=norm,
            edgecolor="#ffffff", linewidth=0.15,
        )
        map_axis.set_title("空间分布", loc="left", fontsize=13, color="#243832", pad=12)
        map_axis.text(
            0.02, 0.03, format_period(current_time, frequency),
            transform=map_axis.transAxes, fontsize=17, fontweight="bold", color="#243832",
            bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.9, "pad": 5},
        )
        map_axis.set_axis_off()

        visible = totals.iloc[: frame_index + 1]
        trend_axis.plot(
            totals["_frame"], totals["_display_value"],
            color="#cfd8d3", linewidth=1.5, zorder=1,
        )
        trend_axis.plot(
            visible["_frame"], visible["_display_value"],
            color="#19715c", linewidth=2.5, zorder=2,
        )
        trend_axis.scatter(
            [visible["_frame"].iloc[-1]], [visible["_display_value"].iloc[-1]],
            s=52, color="#d8a13d", edgecolor="white", linewidth=1.2, zorder=3,
        )
        current_total = visible["_display_value"].iloc[-1]
        trend_axis.text(
            0.98, 0.96, f"{current_total:,.2f} {substance['display_unit']}",
            transform=trend_axis.transAxes, ha="right", va="top",
            fontsize=18, fontweight="bold", color="#243832",
        )
        trend_axis.set_title("区域总量", loc="left", fontsize=13, color="#243832", pad=12)
        trend_axis.set_ylabel(substance["display_unit"], color="#718079")
        trend_axis.grid(axis="y", color="#e2e7e4", linewidth=0.8)
        trend_axis.yaxis.set_major_locator(MaxNLocator(nbins=6))
        trend_axis.spines[["top", "right", "left"]].set_visible(False)
        trend_axis.spines["bottom"].set_color("#dfe5e1")
        trend_axis.tick_params(axis="both", colors="#718079", length=0, labelsize=8)
        trend_axis.set_xlim(totals["_frame"].min(), totals["_frame"].max())
        y_max = totals["_display_value"].max()
        trend_axis.set_ylim(0, y_max * 1.15 if y_max else 1)
        figure.texts[-1].set_text(
            f"{config['dataset_name']}  |  {frequency_label(frequency)}变化"
        )
        return []

    movie = animation.FuncAnimation(
        figure, update, frames=len(frame_times), interval=1000 / visual.get("fps", 3),
        blit=False, repeat=True,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    suffix = output.suffix.lower()
    if suffix == ".gif":
        writer = animation.PillowWriter(fps=visual.get("fps", 3))
    elif suffix == ".mp4":
        if not animation.writers.is_available("ffmpeg"):
            raise RuntimeError("输出 MP4 需要安装 FFmpeg；当前可直接输出 GIF。")
        writer = animation.FFMpegWriter(fps=visual.get("fps", 3), bitrate=2400)
    else:
        raise ValueError("动画输出格式仅支持 .gif 或 .mp4。")
    movie.save(output, writer=writer, dpi=visual.get("dpi", 130))
    plt.close(figure)


def frequency_label(frequency: str) -> str:
    return {"day": "逐日", "month": "逐月", "year": "逐年"}[frequency]


def format_period(value, frequency: str) -> str:
    if frequency == "day":
        return value.strftime("%Y-%m-%d")
    if frequency == "month":
        return value.strftime("%Y-%m")
    return value.strftime("%Y")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成地区物质变化动态图。")
    parser.add_argument("--config", type=Path, required=True, help="JSON 数据配置文件")
    parser.add_argument("--frequency", choices=FREQUENCY_ORDER, required=True, help="动画时间粒度")
    parser.add_argument("--output", type=Path, required=True, help="输出 GIF 或 MP4")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    root = Path(__file__).resolve().parent
    make_animation(load_config(arguments.config), arguments.frequency, arguments.output, root)
