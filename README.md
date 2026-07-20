# 地区物质变化动态图

本项目只用于生成科研动态图，不包含前端、后端或虚构数据。

动态图由两部分组成：

- 空间分布：显示每个网格在当前时间的物质量
- 时间变化：显示目标地区的物质总量及播放进度

## 当前数据

当前已导入新加坡 ODIAC 1 km CO2 排放数据：

- `data/raw/co2/singapore_odiac_1km/`：2021—2023 年月度 CSV
- `data/boundaries/sg_grid_1km_odiac.geojson`：926 个 1 km 网格
- 共 36 个月、33,336 条记录，无缺失、无重复
- 原始单位为 `tC`，不是 `tCO2`

当前源数据为月度数据，因此可以生成逐月和逐年动画。逐日动画必须等待真实日度数据，程序不会将月度数据拆分或虚构为日度数据。

## POI 数据

POI 原始文件位于 `data/raw/poi/`，按四个地区独立存放。数据覆盖 2021—2023 年共 36 个月，并已映射到与 CO2 相同的 1 km 网格。

前端支持“全部类别”和 17 个单独类别，包括餐饮、学校、大学、加油站、医院、诊所、商店、旅游设施、工业/商业/居住用地、工业/商业/零售建筑、仓库、停车设施和公交站点。

POI 是每月快照存量：

- 逐月视图显示对应月份快照
- 逐年视图显示每年 12 月快照
- 不会将 12 个月 POI 快照累加
- `poi_total` 严格等于 17 个类别之和

## 天气数据

天气原始文件位于 `data/raw/weather/`，包含四个地区 2021—2023 年共 36 个月的 Open-Meteo 月度统计。

前端支持五项气象指标：

- 月均 2 m 气温（°C）
- 月均 2 m 相对湿度（%）
- 月累计降水量（mm）
- 月最大 10 m 风速（km/h）
- 月累计短波辐射（MJ/m²）

网页顶部提供“字段与口径”入口。说明弹窗会随当前观测因子和细分指标更新，展示字段含义、数据来源、空间统计及年度聚合依据，不占用地图和趋势图的常驻空间。

`api_lat/api_lon` 是 Open-Meteo API 参考点坐标，不是独立气象指标。区域统计先按参考点去重，避免一个参考点映射到多个网格后被重复加权：

- 温度、湿度、降水和辐射使用参考点空间均值
- 风速使用参考点空间最大值
- 年度温度和湿度取 12 个月均值
- 年度降水和辐射取 12 个月累计
- 年度风速取全年最大值

## VIIRS 夜间灯光

VIIRS 原始文件位于 `data/raw/viirs/`，包含四地区 2021—2023 年共 36 个月的 HKU-VIIRS 500 m 月度夜光数据，并已聚合到现有 1 km 网格。

前端提供三项夜光指标：

- 平均辐亮度：地图默认使用 `log1p(ntl_radiance_mean)` 着色，统计和详情保留原始物理量
- 最大辐亮度：显示网格或区域极亮值
- 总辐亮度：显示有效像元辐亮度之和

区域平均辐亮度按有效像元加权计算：`Σ ntl_radiance_sum ÷ Σ ntl_valid_pixel_count`。逐年模式下，平均辐亮度取年均、最大辐亮度取全年最大、总辐亮度取 12 个月月均。

质量字段会在页面明确呈现：有效像元数、是否缺失、是否填补、来源和统计日期。新加坡 `2022-07` 与 `2023-01` 为整月填补数据，动画保留这些月份并使用质量徽标、地图边框和空心趋势点标注。

## 环境

```bash
conda activate carbon-vis
```

环境位置：`C:\Users\Administrator\.conda\envs\carbon-vis`

## 生成动画

逐月：

```bash
conda run -n carbon-vis python manage.py animate \
  --config config/co2_singapore.json \
  --frequency month \
  --output output/animations/co2_singapore_month.gif
```

逐年：

```bash
conda run -n carbon-vis python manage.py animate \
  --config config/co2_singapore.json \
  --frequency year \
  --output output/animations/co2_singapore_year.gif
```

`--frequency` 支持 `day`、`month`、`year`，但不能选择比源数据更细的时间粒度。

## 更换地区

在配置文件的 `region.mode` 中选择：

- `all`：使用数据中的全部网格
- `cells`：通过 `cell_ids` 指定一组网格
- `boundary`：通过外部 GeoJSON 或 Shapefile 行政边界裁切网格

## 更换物质

复制一份 JSON 配置，修改以下项目：

- `data.files`：新物质的数据文件
- `substance.value_column`：数值字段
- `substance.source_unit`：原始单位
- `substance.display_unit`：图中单位
- `substance.display_factor`：单位换算系数
- `substance.aggregation`：时间聚合方式，通常为 `sum` 或 `mean`

动画色阶在完整时间范围内固定，保证不同帧可以直接比较。

## 交互前端

前端与 GIF 使用同一批真实数据，功能包括：

- 926 个网格随时间动态变色
- 逐月与逐年切换
- 播放、暂停和时间滑块定位
- 点击网格时自动暂停
- 显示网格坐标、当前排放、空间排名和完整历史曲线
- 地图缩放、拖动和复位

先更新浏览器数据包：

```bash
conda run -n carbon-vis python manage.py export-web \
  --output web/data/dataset.js
```

地区、因子、单位、时间聚合和色阶统一配置在 `config/data_catalog.json`。扩展规范见下方“可扩展数据架构”。

启动本地页面：

```bash
conda run -n carbon-vis python -m http.server 8000 --directory web
```

浏览器访问 `http://127.0.0.1:8000`。

当前前端包含新加坡、纽约市、东京都市区和芝加哥，可以通过页面右上方的地区选择器切换。也可以直接访问：

- 新加坡：`http://127.0.0.1:8000/?region=singapore`
- 纽约市：`http://127.0.0.1:8000/?region=new-york`
- 东京都市区：`http://127.0.0.1:8000/?region=tokyo`
- 芝加哥：`http://127.0.0.1:8000/?region=chicago`

## 可扩展数据架构

### 分层

项目分为四层：

1. `data/raw/`：原始数据，只按因子和地区归档，不在前端直接读取。
2. `config/data_catalog.json`：统一声明地区、因子、字段、单位、时间口径、色阶和文案。
3. `regional_observatory/`：数据适配、导出、绘图和 Demo 打包实现，不提供独立执行入口。
4. `web/`：通用可视化界面，只消费导出的元数据和矩阵，不包含具体因子判断。

项目唯一命令入口是根目录 `manage.py`。所有任务必须通过其子命令执行，包内模块不可直接运行。

地区几何只导出一次，由同一地区的全部因子共享。每个因子只保存时间序列矩阵和显示元数据。

### 数据适配器

当前支持两种通用适配器：

- `single_value`：每条网格-时间记录只有一个数值字段，例如 CO2 排放。
- `wide_categories`：每条网格-时间记录包含多个分类数值字段，例如 POI 分类。
- `wide_metrics`：每条网格-时间记录包含多个不同单位和聚合规则的指标，例如天气特征。
- `nightlights`：同时导出夜光物理量、对数地图值、有效像元加权区域序列和质量标记。

共同要求：

- 每个地区、网格、时间组合唯一。
- 数据必须包含地区配置的 `join_column`。
- 时间字段与 `period_format` 一致。
- 每个时间点必须覆盖该地区完整网格，缺失时导出失败，不自动填零。

### 时间口径

- `temporal_kind: flow`：年度值为各月求和，适用于排放量等期间流量。
- `temporal_kind: snapshot`：年度值取当年最后一期，适用于 POI 等时点存量。

### 新增因子

1. 将原始文件放入 `data/raw/<factor>/<region>/`。
2. 在 `data_catalog.json` 的每个适用地区下配置数据文件路径。
3. 在 `topics` 中声明因子元数据和适配器。
4. 运行导出命令：

```bash
conda run -n carbon-vis python manage.py export-web
```

前端会自动新增因子选项，并根据 catalog 控制：

- 标签与分类
- 网格值和区域值单位
- 小数精度与换算系数
- 年度聚合口径
- 色阶范围、零值颜色和整数刻度
- 地图标题、来源与页脚说明

只有当新数据无法表示为现有两种表结构时，才需要在导出器增加新适配器。前端通常不需要修改。

### 前端数据契约

顶层数据包含默认地区、默认因子、因子顺序和地区集合。每个地区包含：

- `meta`：地区标识、名称和网格数。
- `features`：共享网格几何和坐标属性。
- `topics`：该地区支持的因子。

每个因子包含完整显示元数据、时间列表和数值矩阵。分类因子额外包含分类列表、默认分类和按分类组织的矩阵。

## 老师汇报离线版

独立交付文件位于 `teacher_demo/`：

- `carbon_visualization_demo.html`：四地区数据、样式和交互全部内嵌，双击即可打开
- `使用说明.txt`：简短操作说明

更新前端或数据后，重新生成离线文件：

```bash
conda run -n carbon-vis python manage.py build-demo
```
