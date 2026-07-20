"""Export catalog-defined regional factors as a browser-ready data bundle."""

from __future__ import annotations

import glob
import json
from pathlib import Path


def read_catalog(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def matching_files(project_root: Path, pattern: str) -> list[Path]:
    resolved = str((project_root / pattern).resolve())
    paths = sorted(Path(item) for item in glob.glob(resolved))
    if not paths:
        raise FileNotFoundError(f"未找到数据文件：{resolved}")
    return paths


def load_records(project_root: Path, pattern: str):
    import pandas as pd

    return pd.concat(
        [pd.read_csv(path) for path in matching_files(project_root, pattern)],
        ignore_index=True,
    )


def prepare_records(records, topic: dict, join_column: str):
    import pandas as pd

    period_column = topic["period_column"]
    required = {join_column, period_column}
    missing = required - set(records.columns)
    if missing:
        raise ValueError(f"数据缺少字段：{', '.join(sorted(missing))}")
    records["_time"] = pd.to_datetime(
        records[period_column].astype(str), format=topic["period_format"], errors="raise"
    )
    if records.duplicated([join_column, "_time"]).any():
        raise ValueError("数据中存在重复的网格-时间记录。")
    return records, sorted(records["_time"].unique())


def matrix(records, value_column: str, join_column: str, cell_ids: list[str], periods):
    pivot = records.pivot(index=join_column, columns="_time", values=value_column)
    pivot = pivot.reindex(index=cell_ids, columns=periods)
    if pivot.isna().any().any():
        raise ValueError(f"字段 {value_column} 存在缺失的网格-时间组合。")
    return pivot


def build_single_value(records, topic: dict, join_column: str, cell_ids: list[str], periods) -> dict:
    value_column = topic["value_column"]
    if value_column not in records.columns:
        raise ValueError(f"数据缺少数值字段：{value_column}")
    values = matrix(records, value_column, join_column, cell_ids, periods)
    return {"values": values.round(6).values.tolist()}


def build_wide_categories(records, topic: dict, join_column: str, cell_ids: list[str], periods) -> dict:
    categories = topic.get("categories", [])
    category_ids = [item["id"] for item in categories]
    missing = set(category_ids) - set(records.columns)
    if missing:
        raise ValueError(f"数据缺少分类字段：{', '.join(sorted(missing))}")
    values = {
        category_id: matrix(records, category_id, join_column, cell_ids, periods)
        .astype(int)
        .values.tolist()
        for category_id in category_ids
    }
    return {"categories": categories, "defaultCategory": category_ids[0], "values": values}


def build_wide_metrics(records, topic: dict, join_column: str, cell_ids: list[str], periods) -> dict:
    metrics = topic.get("metrics", [])
    metric_ids = [item["id"] for item in metrics]
    reference_columns = topic.get("reference_columns", [])
    missing = set(metric_ids + reference_columns) - set(records.columns)
    if missing:
        raise ValueError(f"天气数据缺少字段：{', '.join(sorted(missing))}")

    values = {
        metric_id: matrix(records, metric_id, join_column, cell_ids, periods)
        .round(6)
        .values.tolist()
        for metric_id in metric_ids
    }
    reference_by_cell = records[[join_column, *reference_columns]].drop_duplicates()
    if reference_by_cell.duplicated(join_column).any():
        raise ValueError("同一网格的气象 API 参考点随时间变化。")
    reference_by_cell = reference_by_cell.set_index(join_column).reindex(cell_ids)
    if reference_by_cell.isna().any().any():
        raise ValueError("部分网格缺少气象 API 参考点。")

    unique_reference = records.drop_duplicates(["_time", *reference_columns])
    regional_values = {}
    for metric in metrics:
        grouped = unique_reference.groupby("_time")[metric["id"]]
        aggregation = metric["spatial_aggregation"]
        if aggregation == "mean_unique_reference":
            series = grouped.mean()
        elif aggregation == "max_unique_reference":
            series = grouped.max()
        else:
            raise ValueError(f"未知空间聚合口径：{aggregation}")
        regional_values[metric["id"]] = series.reindex(periods).round(6).tolist()

    categories = [
        {**metric, "legend_unit": metric.get("legend_unit", metric["unit"]), "show_rate": metric.get("show_rate", True)}
        for metric in metrics
    ]
    return {
        "categories": categories,
        "defaultCategory": topic["defaultCategory"],
        "values": values,
        "regionalValues": regional_values,
        "references": reference_by_cell[reference_columns].round(6).values.tolist(),
    }


def build_nightlights(records, topic: dict, join_column: str, cell_ids: list[str], periods) -> dict:
    metrics = topic["metrics"]
    required = {
        "ntl_radiance_mean", "ntl_radiance_max", "ntl_radiance_sum",
        "ntl_valid_pixel_count", "ntl_is_missing", "ntl_is_imputed",
        "source", "start_date", "end_date",
    }
    missing = required - set(records.columns)
    if missing:
        raise ValueError(f"VIIRS 数据缺少字段：{', '.join(sorted(missing))}")
    if not records["ntl_is_missing"].isin([0, 1]).all() or not records["ntl_is_imputed"].isin([0, 1]).all():
        raise ValueError("VIIRS 缺失或填补标记必须为 0/1。")
    values = {}
    regional_values = {}
    for metric in metrics:
        metric_id = metric["id"]
        values[metric_id] = matrix(records, metric_id, join_column, cell_ids, periods).round(6).values.tolist()
        grouped = records.groupby("_time")
        aggregation = metric["spatial_aggregation"]
        if aggregation == "weighted_mean_pixels":
            series = grouped["ntl_radiance_sum"].sum() / grouped["ntl_valid_pixel_count"].sum()
        elif aggregation == "max":
            series = grouped[metric_id].max()
        elif aggregation == "sum":
            series = grouped[metric_id].sum()
        else:
            raise ValueError(f"未知 VIIRS 空间聚合口径：{aggregation}")
        regional_values[metric_id] = series.reindex(periods).round(6).tolist()

    quality_fields = ["ntl_valid_pixel_count", "ntl_is_missing", "ntl_is_imputed"]
    quality = {
        field: matrix(records, field, join_column, cell_ids, periods).astype(int).values.tolist()
        for field in quality_fields
    }
    period_quality = []
    for period in periods:
        current = records.loc[records["_time"] == period]
        period_quality.append({
            "missingCount": int(current["ntl_is_missing"].sum()),
            "imputedCount": int(current["ntl_is_imputed"].sum()),
            "validPixelCount": int(current["ntl_valid_pixel_count"].sum()),
            "source": str(current["source"].iloc[0]),
            "startDate": str(current["start_date"].iloc[0]),
            "endDate": str(current["end_date"].iloc[0]),
        })
    return {
        "categories": metrics,
        "defaultCategory": topic["defaultCategory"],
        "values": values,
        "regionalValues": regional_values,
        "quality": quality,
        "periodQuality": period_quality,
    }


def build_remote_sensing(records, topic: dict, join_column: str, cell_ids: list[str], periods) -> dict:
    """Build remote-sensing metrics with per-metric valid-pixel quality data."""
    metrics = topic["metrics"]
    required = {"source", "start_date", "end_date"}
    for metric in metrics:
        required.update({metric["id"], metric["pixel_count_column"]})
    missing = required - set(records.columns)
    if missing:
        raise ValueError(f"Remote-sensing data is missing fields: {', '.join(sorted(missing))}")

    values = {}
    regional_values = {}
    metric_quality = {}
    period_quality = {}
    for metric in metrics:
        metric_id = metric["id"]
        count_column = metric["pixel_count_column"]
        valid = records[count_column].fillna(0).gt(0) & records[metric_id].notna()
        cleaned = records.assign(_metric_value=records[metric_id].where(valid))
        value_matrix = cleaned.pivot(index=join_column, columns="_time", values="_metric_value")
        value_matrix = value_matrix.reindex(index=cell_ids, columns=periods)
        export_values = value_matrix.round(6).astype(object).where(value_matrix.notna(), None)
        values[metric_id] = export_values.values.tolist()

        count_matrix = records.pivot(index=join_column, columns="_time", values=count_column)
        count_matrix = count_matrix.reindex(index=cell_ids, columns=periods).fillna(0).astype(int)
        metric_quality[metric_id] = {"validPixelCount": count_matrix.values.tolist()}

        weighted = cleaned.assign(_weighted=cleaned["_metric_value"] * cleaned[count_column])
        grouped = weighted.groupby("_time")
        numerator = grouped["_weighted"].sum(min_count=1)
        denominator = grouped[count_column].sum()
        regional_values[metric_id] = (numerator / denominator).reindex(periods).round(6).tolist()

        entries = []
        for period in periods:
            current = cleaned.loc[cleaned["_time"] == period]
            entries.append({
                "missingCount": int(current["_metric_value"].isna().sum()),
                "imputedCount": 0,
                "validPixelCount": int(current.loc[current["_metric_value"].notna(), count_column].sum()),
                "source": str(current["source"].iloc[0]),
                "startDate": str(current["start_date"].iloc[0]),
                "endDate": str(current["end_date"].iloc[0]),
            })
        period_quality[metric_id] = entries

    return {
        "categories": metrics,
        "defaultCategory": topic["defaultCategory"],
        "values": values,
        "regionalValues": regional_values,
        "metricQuality": metric_quality,
        "periodQualityByMetric": period_quality,
    }


ADAPTERS = {
    "single_value": build_single_value,
    "wide_categories": build_wide_categories,
    "wide_metrics": build_wide_metrics,
    "nightlights": build_nightlights,
    "remote_sensing": build_remote_sensing,
}


def public_topic_meta(topic: dict) -> dict:
    excluded = {"adapter", "value_column", "period_column", "period_format", "categories", "metrics", "reference_columns"}
    return {key: value for key, value in topic.items() if key not in excluded}


def build_topic(project_root: Path, region: dict, topic_id: str, topic: dict, cell_ids: list[str]) -> dict:
    source = region["topics"].get(topic_id)
    if not source:
        raise ValueError(f"地区 {region['id']} 未配置因子 {topic_id}。")
    records = load_records(project_root, source["files"])
    records, periods = prepare_records(records, topic, region["join_column"])
    adapter_name = topic["adapter"]
    if adapter_name not in ADAPTERS:
        raise ValueError(f"未知数据适配器：{adapter_name}")
    payload = ADAPTERS[adapter_name](
        records, topic, region["join_column"], cell_ids, periods
    )
    return {
        **public_topic_meta(topic),
        "periods": [item.strftime("%Y-%m") for item in periods],
        **payload,
    }


def build_features(project_root: Path, region: dict):
    import geopandas as gpd

    geometry = gpd.read_file(project_root / region["geometry"])
    join_column = region["join_column"]
    if join_column not in geometry.columns:
        raise ValueError(f"边界文件缺少连接字段：{join_column}")
    geometry = geometry.sort_values(join_column).reset_index(drop=True)
    cell_ids = geometry[join_column].astype(str).tolist()
    geometry_json = json.loads(geometry.to_json(drop_id=True))
    features = []
    for feature in geometry_json["features"]:
        properties = feature["properties"]
        features.append(
            {
                "id": str(properties[join_column]),
                "row": int(properties.get("row", 0)),
                "col": int(properties.get("col", 0)),
                "lon": properties.get("lon"),
                "lat": properties.get("lat"),
                "geometry": feature["geometry"],
            }
        )
    return cell_ids, features


def build_region(project_root: Path, region: dict, topics: dict) -> tuple[str, dict]:
    cell_ids, features = build_features(project_root, region)
    region_topics = {
        topic_id: build_topic(project_root, region, topic_id, topic, cell_ids)
        for topic_id, topic in topics.items()
        if topic_id in region["topics"]
    }
    return region["id"], {
        "meta": {
            "id": region["id"],
            "region": region["name"],
            "regionZh": region.get("name_zh", region["name"]),
            "cellCount": len(features),
        },
        "features": features,
        "topics": region_topics,
    }


def export(catalog_path: Path, output: Path) -> None:
    project_root = Path(__file__).resolve().parent.parent
    catalog = read_catalog(catalog_path)
    regions = dict(
        build_region(project_root, region, catalog["topics"])
        for region in catalog["regions"]
    )
    payload = {
        "defaultRegion": catalog["default_region"],
        "defaultTopic": catalog["default_topic"],
        "topicOrder": list(catalog["topics"]),
        "regions": regions,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    output.write_text(f"window.CARBON_DATA={encoded};\n", encoding="utf-8")
