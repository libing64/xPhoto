# xPhoto — RAW 自动修图工具

把一整个目录的 RAW 文件（索尼 `.ARW`，也支持 `.DNG / .CR2 / .CR3 / .NEF / .RAF …`）
自动修完：**显影 → 场景分析 → 调色 → 降噪 → 导出**，再用一个网页把效果看得见、调得动。

```
data/*.ARW ──┬─ darktable-cli （可用时）──┐
             └─ 自带显影引擎 ─────────────┴─▶ 分析 + 调色 ──▶ out/*.jpg + manifest.json ──▶ 浏览器编辑器
```

## 快速开始

```bash
# 1) 依赖（只需一次）
python3 -m venv .venv && .venv/bin/pip install rawpy numpy scipy pillow

# 2) 修图：读取 data/，输出到 out/（自动检测 darktable，有就用）
.venv/bin/python xphoto.py --input data --output out

# 3) 起一个本地服务（浏览器不允许 file:// 直接读 out/manifest.json）
python3 -m http.server 8080

# 4) 打开 http://localhost:8080
```

21 张 10MP 的 ARW 在 4 核并行下约 48 秒处理完。

## 两个显影引擎

`--engine auto`（默认）会先找 `darktable-cli`，找到就用它显影，找不到退回自带流。

| 引擎 | 谁来显影 | 特点 |
| --- | --- | --- |
| `darktable` | `darktable-cli <raw> <jpg>` 的默认场景参照管线 | 更好的去马赛克、**Lensfun 镜头校正**、按相机噪声配置文件降噪、sigmoid 色调映射。10MP 单张多花约 1–2 秒 |
| `native` | 自带流（LibRaw + 自研模块） | 零额外依赖，速度更快 |

```bash
sudo apt install darktable            # 装好之后重跑就是 darktable 引擎

python xphoto.py --engine darktable    # 强制用 darktable（找不到会报错退出）
python xphoto.py --engine native       # 强制用自带流
python xphoto.py --darktable /path/to/darktable-cli --dt-style "我的风格"
```

**为什么不直接写 XMP 来控制 darktable 的模块？** darktable 的历史记录里模块参数是
二进制结构体（含 modversion），跨版本手写极易产生黑图/崩溃。所以这里让 darktable
负责它最擅长的部分（RAW → 一张高质量显影），风格调整和精细化仍由 xPhoto 负责，
两边职责清晰、互不越界。darktable 引擎下网页的对比标签会变成「darktable 默认显影 / xPhoto 修图」。

## 目录

| 路径 | 说明 |
| --- | --- |
| `xphoto.py` | 修图流水线（CLI） |
| `index.html` / `app.js` / `styles.css` | 网页端：相册 + 编辑器（WebGL 实时渲染） |
| `data/` | 原始 RAW（不入库） |
| `out/` | `<id>/neutral.jpg`（底片）、`auto.jpg`（自动修图）、`full.jpg`（全分辨率）、`thumb.jpg`、`dt_base.jpg`（仅 darktable 模式），以及 `manifest.json` |

## 流水线做了什么

1. **显影**：darktable 或 LibRaw（相机白平衡 + sRGB 矩阵 + AHD 去马赛克），输出线性 16bit。
2. **归一**：黑/白点归一，把 99.5 分位压到 0.9，得到一张"平灰"的中性底片（`neutral.jpg`，网页里的"原片"）。
3. **场景分析**：亮度分位（1/5/10/25/50/75/90/98/99.5）、过曝比例、色度饱和度均值、肤色像素占比（色相 8°–46°）、噪声 σ（高通残差 MAD 估计）、白点亮度。
4. **自动调色**：曝光（中位亮度死区 0.36–0.52）、灰世界白平衡微调（限 ±8，防止毁掉日落/暖灯）、阴影提亮、高光回收、S 曲线对比、中间调钟形提亮、肤色保护的鲜艳度。
5. **高光肩部**：darktable `sigmoid` 同款的扩展 Reinhard 曲线（`L·(1+L/W²)/(1+L)`）——中灰不变、白点平滑渐进到 1.0，高光不再硬切。
6. **降噪（小波）**：darktable `profiled denoise` 的 wavelet 模式同款——à trous B3 样条三层分解，
   每个尺度按噪声 σ 做软阈值（σ 系数 0.852 / 0.446 / 0.233），亮度/色度分离、色度阈值放大 2.4 倍。
   10MP 单张约 1.2 秒，比原来的引导滤波快 3 倍且更保纹理。
7. **色彩分级**：`color balance rgb` 思路的阴影/高光分离色调（`shadowTint` / `highlightTint`），做青橙、胶片冷暖分离。
8. **细节**：双尺度局部对比（小半径=质感，大半径=去灰），非锐化掩膜锐化（带光晕钳制）。
9. **导出**：`neutral / auto / full / thumb` 四套 JPEG + `manifest.json`（含 EXIF、分析数据、三套风格参数）。

三套风格参数（自然 / 通透 / 胶片）在 Python 端算好后写进 manifest，网页端用**同一套数学公式**在 GPU 上重算：

> 网页默认看到的效果 ≈ 导出的 `auto.jpg`，滑块只是在这套公式上继续微调。
> （实测两端逐像素平均误差 0.23%；差异主要来自 CPU 小波降噪 vs GPU 双边近似。）

## 网页端操作

| 操作 | 说明 |
| --- | --- |
| 点击照片 | 进入编辑器 |
| 拖动画面中的竖分割线 | 左边底片 / 右边修图，实时对比 |
| 按住「对比」或空格 | 整幅切换成未修图状态 |
| 滚轮 / 双击 / 0 | 缩放，双击或 `0` 复位 |
| 拖动画面 | 放大后可平移 |
| 右侧滑块 | 曝光、对比、高光、阴影、中间调 / 色温、色调、饱和度、鲜艳度 / **阴影色调、高光色调** / 清晰度、降噪、锐化 |
| 预设 | 自然 / 通透（青橙分级）/ 胶片（暖阴影冷高光），一键切换 |
| `←` `→` | 上一张 / 下一张；`Esc` 返回相册 |
| 导出 | 按当前参数在浏览器里重渲染并下载 JPEG；也可下载 Python 导出的全分辨率版本 |

深链：`index.html#DSC07910/vivid` 直接打开某张图的某个预设。

## 常用参数

```bash
python xphoto.py --input data --output out \
  --engine auto      # auto / native / darktable
  --darktable PATH   # 指定 darktable-cli（默认自动查找 PATH 与常见安装位置）
  --dt-style NAME    # 透传给 darktable-cli --style
  --preview 2200     # 网页预览长边（默认 2200，兼顾清晰度与显存）
  --thumb 560        # 相册缩略图
  --jobs 4           # 并行进程数（每张峰值约 1GB 内存）
  --limit 3          # 只处理前 3 张，调试用
```

## 说明与取舍

- **白平衡只做微调**：生活照场景里，灰世界全量校正会把暖光、夕阳、霓虹全部拉平，所以限制在 ±8，剩下的交给色温滑块。
- **肤色保护**：肤色占比高时自动降低鲜艳度与清晰度，避免脸变"塑料"或"脏"。
- **网页的降噪是近似**：GPU 端用 9 taps 双边近似替代 CPU 的 à trous 小波（单 pass 里做不了多尺度分解），预览不是逐像素相同；要最终画质用 `out/<id>/full.jpg`。
- **darktable 引擎的基准图是 8bit JPEG**：足以支撑后续调色；需要 16bit 就在 `darktable_develop()` 里把输出改成 `.tif`。
- 输出 JPEG 是 sRGB / 8bit。需要 16bit TIFF 或更严格的色彩管理，可以改 `save_jpeg` 换成 `tifffile`。
