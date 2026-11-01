# xPhoto — RAW 自动修图工具

把一整个目录的 RAW 文件（索尼 `.ARW`，也支持 `.DNG / .CR2 / .CR3 / .NEF / .RAF …`）
自动修完：**darktable 显影 → 场景分析 → 调色 → 降噪 → 导出**，再用一个网页把效果看得见、调得动。

```
data/*.ARW ──▶ darktable-cli 显影（默认）──┐
             └ 自带线性解码（回退）───────┴─▶ 分析 + 调色 ──▶ out/<同名>.jpg ──▶ 浏览器编辑器
```

## 快速开始

```bash
# 1) 依赖
sudo apt install darktable                     # 显影引擎（装了就是默认，不装自动回退）
python3 -m venv .venv && .venv/bin/pip install rawpy numpy scipy pillow

# 2) 修图：读取 data/，输出到 out/
.venv/bin/python xphoto.py --input data --output out

# 3) 起一个本地服务（浏览器不允许 file:// 直接读 out/manifest.json）
python3 -m http.server 8080

# 4) 打开 http://localhost:8080
```

21 张 10MP 的 ARW 在 5 进程并行下约 42 秒处理完。

## 输出约定

`out/` 是**平铺**的，不建子目录、每张 RAW 只留一张全分辨率成品：

```
out/
├── DSC07910.jpg        # 3968×2648，q93，修图成品
├── DSC07920.jpg
├── ...
└── manifest.json       # EXIF + 场景分析 + 已烘焙参数 + 相册用的小图
```

`--quality` 可调成品 JPEG 质量；`--output` 可换目录。相册里的小图存在 `manifest.json`
的 `preview` 字段（480px 的 data URI），所以磁盘上不需要额外缩略图。

## 显影引擎

默认 `--engine darktable`：找到 `darktable-cli` 就用它，没找到会打印提示并自动回退到 `native`。

| 引擎 | 谁来显影 | 特点 |
| --- | --- | --- |
| `darktable`（默认） | `darktable-cli <raw> <jpg>` 的默认管线 | 更好的去马赛克、**Lensfun 镜头校正**、按相机噪声配置文件降噪、色调映射。每张多花约 1–2 秒 |
| `auto` | 有 darktable 就用，否则回退 | 等价于默认行为 |
| `native` | 自带流（LibRaw + 自研模块） | 零额外依赖 |

```bash
python xphoto.py --engine native                 # 强制自带流
python xphoto.py --darktable /path/to/cli        # 指定 darktable-cli 路径
python xphoto.py --dt-style "我的风格"            # 透传 darktable-cli --style
```

两个实现细节（踩过的坑）：

- **CLI 参数**：4.6 是 `darktable-cli <in> <out> [--hq true]`，`--core` 后面必须跟 darktable 自身选项，乱加会报
  `-d signal` 之类的解析错误。
- **并行一定要隔离配置目录**：多个实例共用 `library.db` 会撞 SQLite 锁直接 abort，
  所以每个进程带一个 `--core --configdir /tmp/xphoto_darktable_<pid>`。

**为什么不写 XMP 控制 darktable 的模块？** 历史记录里模块参数是含 modversion 的二进制结构体，
跨版本手写极易黑图或崩溃。让 darktable 负责它最擅长的「RAW → 一张高质量显影」，风格调整由 xPhoto 负责。

因为 darktable 的显影已经做完了曝光补偿与色调映射，xPhoto 侧的自动调色会**自动降档**
（`soften_for_develop()`：对比/阴影/高光/清晰度 ×0.55–0.65，降噪上限 18），只是轻推一把。

## 目录

| 路径 | 说明 |
| --- | --- |
| `xphoto.py` | 修图流水线（CLI） |
| `index.html` / `app.js` / `styles.css` | 网页端：相册 + 编辑器（WebGL 实时渲染） |
| `data/` | 原始 RAW（不入库） |
| `out/` | 每张 RAW 一个同名 jpg + `manifest.json`（不入库） |

## 流水线做了什么

1. **显影**：darktable 默认管线（或 LibRaw：相机白平衡 + sRGB 矩阵 + AHD 去马赛克）。
2. **场景分析**：亮度分位（1/5/10/25/50/75/90/98/99.5）、过曝比例、色度饱和度均值、
   肤色像素占比（色相 8°–46°）、噪声 σ（高通残差 MAD 估计）、白点亮度。
3. **自动调色**：曝光（中位亮度死区 0.36–0.52）、灰世界白平衡微调（限 ±8，防止毁掉日落/暖灯）、
   阴影提亮、高光回收、S 曲线对比、中间调钟形提亮、肤色保护的鲜艳度。
4. **色彩分级**：`color balance rgb` 思路的阴影/高光分离色调（`shadowTint` / `highlightTint`）。
5. **降噪（小波）**：darktable `profiled denoise` 的 wavelet 模式同款——à trous B3 样条三层分解，
   每个尺度按噪声 σ 软阈值（系数 0.852 / 0.446 / 0.233），亮度/色度分离、色度阈值 ×2.4。
6. **细节**：双尺度局部对比（小半径=质感，大半径=去灰），非锐化掩膜锐化（带光晕钳制）。
7. **导出**：`out/<id>.jpg` + `manifest.json`（EXIF、分析数据、已烘焙参数、480px 预览小图）。

网页端用**同一套数学公式**在 GPU 上重算，所以滑块全零时的画面 = 磁盘上那张 jpg：

> 实测：全零参数两端逐像素差 **0.00%**；「通透」预设 0.16%（清晰度在 GPU 用 mipmap、CPU 用 box blur）；
> 「胶片」0.00%。降噪开着时差异约 1%（CPU 小波 vs GPU 双边近似，属预期）。

## 网页端操作

| 操作 | 说明 |
| --- | --- |
| 点击照片 | 进入编辑器 |
| 右侧滑块 | 在「自动成品」之上追加调整：曝光、对比、高光、阴影、中间调 / 色温、色调、饱和度、鲜艳度 / 阴影色调、高光色调 / 清晰度、降噪、锐化 |
| 预设 | 原味（= 自动成品）/ 通透 / 胶片，都是叠加在成品上的增量 |
| 拖动竖分割线 | 左边自动成品 / 右边当前调整；参数全零时自动隐藏（两边是同一张） |
| 按住「对比」或空格 | 整幅切回自动成品 |
| 滚轮 / 双击 / 0 | 缩放，双击或 `0` 复位；放大后可拖动平移 |
| `←` `→` | 上一张 / 下一张；`Esc` 返回相册；`R` 回到自动成品；`E` 导出 |
| 导出 | 按当前参数在浏览器重渲染下载 JPEG；也可直接下载 `out/<id>.jpg` |

深链：`index.html#DSC07910/clear` 直接打开某张图的某个预设。

## 常用参数

```bash
python xphoto.py --input data --output out \
  --quality 93       # 成品 JPEG 质量
  --engine darktable # darktable（默认）/ auto / native
  --darktable PATH   # 指定 darktable-cli（默认自动查找 PATH 与常见安装位置）
  --dt-style NAME    # 透传给 darktable-cli --style
  --jobs 5           # 并行进程数（每张峰值约 1GB 内存）
  --limit 3          # 只处理前 3 张，调试用
```

## 说明与取舍

- **白平衡只做微调**：生活照场景里灰世界全量校正会把暖光、夕阳、霓虹全部拉平，所以限制在 ±8，剩下的交给色温滑块。
- **肤色保护**：肤色占比高时自动降低鲜艳度与清晰度，避免脸变「塑料」或「脏」。
- **网页的降噪是近似**：GPU 端用 9 taps 双边近似替代 CPU 的 à trous 小波（单 pass 里做不了多尺度分解）；
  要最终画质直接用 `out/<id>.jpg`，它已经是 CPU 小波的结果。
- **darktable 的基准是 8bit JPEG**：足够支撑后续调色；要 16bit 就把 `darktable_develop()` 的输出改成 `.tif`。
- 成品是 sRGB / 8bit JPEG。需要 16bit TIFF 或更严格的色彩管理，可以替换 `save_jpeg`。
