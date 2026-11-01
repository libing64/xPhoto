#!/usr/bin/env python3
"""
xPhoto — RAW 自动修图流水线
============================

一条命令把目录里的 RAW（.ARW/.DNG/.CR3...）自动修完，每张只产出一张全分辨率成品：

    python xphoto.py --input data --output out     # → out/DSC07910.jpg ...

对每张照片依次执行：
    1. 显影（默认 darktable-cli，缺失时回退到 LibRaw 自带流）
    2. 场景分析（直方图分位、噪声 sigma、肤色占比、饱和度、过曝比例）
    3. 自动曝光 / 白平衡微调 / 阴影提亮 / 高光回收 / S 曲线对比 / 中间调
    4. 小波降噪（亮度 + 色度分离）、色彩分级、清晰度、锐化
    5. 导出 out/<同名>.jpg，并把 EXIF / 分析 / 已烘焙参数 / 相册小图写进 manifest.json

输出目录是平铺的，不建子目录、不留中性底片和缩略图文件。
网页端用同一套公式在 GPU 上重算，滑块全零时的画面就等于磁盘上那张成品。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from scipy.ndimage import correlate1d, uniform_filter

try:
    import rawpy
except ImportError:  # pragma: no cover
    rawpy = None

LUMA_W = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
EPS = 1e-6

# 参数体系（与 web/app.js 中的 shader 完全一致，单位都是"百分比"或 EV）
PARAM_KEYS = [
    "ev", "contrast", "highlights", "shadows", "midtone", "temp", "tint",
    "shadowTint", "highlightTint",
    "saturation", "vibrance", "clarity", "denoise", "sharpen",
]

PARAM_RANGE = {
    "ev": (-2.0, 2.0),
    "contrast": (-60, 80),
    "highlights": (-80, 40),
    "shadows": (-40, 80),
    "midtone": (-50, 50),
    "temp": (-30, 30),
    "tint": (-30, 30),
    "shadowTint": (-40, 40),
    "highlightTint": (-40, 40),
    "saturation": (-60, 60),
    "vibrance": (-40, 60),
    "clarity": (-40, 60),
    "denoise": (0, 100),
    "sharpen": (0, 100),
}


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * LUMA_W[0] + img[..., 1] * LUMA_W[1] + img[..., 2] * LUMA_W[2]


def to_linear(x: np.ndarray) -> np.ndarray:
    return np.power(np.clip(x, 0.0, 1.0), 2.2, dtype=np.float32)


def to_display(x: np.ndarray) -> np.ndarray:
    return np.power(np.clip(x, 0.0, 1.0), 1.0 / 2.2, dtype=np.float32)


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0 + EPS), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def inv_smoothstep(p: np.ndarray) -> np.ndarray:
    """smoothstep 的解析反函数，用来做"降对比"。"""
    p = np.clip(p, 0.0, 1.0)
    arg = np.clip(1.0 - 2.0 * p, -1.0, 1.0)
    return np.clip(0.5 - np.sin(np.arcsin(arg) / 3.0), 0.0, 1.0)


def box_blur(img: np.ndarray, radius: int, passes: int = 3) -> np.ndarray:
    """多次盒滤波近似高斯，O(1)/像素。"""
    r = max(1, int(radius))
    out = img.astype(np.float32, copy=True)
    for _ in range(passes):
        out = uniform_filter(out, size=2 * r + 1, mode="reflect")
    return out


def guided_filter(guide: np.ndarray, src: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """引导滤波：以 guide 的结构去平滑 src，边缘保持。

    目前主链改用 à trous 小波，这个保留给自定义调参时做局部色调映射用。
    """
    r = max(1, int(radius))
    size = 2 * r + 1
    mI = uniform_filter(guide, size, mode="reflect")
    mP = uniform_filter(src, size, mode="reflect")
    corr_I = uniform_filter(guide * guide, size, mode="reflect")
    corr_IP = uniform_filter(guide * src, size, mode="reflect")
    varI = corr_I - mI * mI
    covIP = corr_IP - mI * mP
    a = covIP / (varI + eps)
    b = mP - a * mI
    return uniform_filter(a, size, mode="reflect") * guide + uniform_filter(b, size, mode="reflect")


# --------------------------------------------------------------------------
# EXIF（自己解析 TIFF IFD，不依赖 exiftool）
# --------------------------------------------------------------------------
_TAG_NAMES = {
    0x010F: "make", 0x0110: "model", 0x0131: "software", 0x0132: "datetime",
    0x829A: "exposure_time", 0x829D: "fnumber", 0x8827: "iso",
    0x9003: "datetime_original", 0x920A: "focal_length", 0xA434: "lens",
    0x9209: "flash", 0xA002: "pixel_x", 0xA003: "pixel_y",
}

_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


def _read_ifd(data: bytes, bo: str, offset: int, out: Dict[str, Any], depth: int = 0) -> None:
    if depth > 3 or offset <= 0 or offset + 2 > len(data):
        return
    try:
        n = struct.unpack(bo + "H", data[offset: offset + 2])[0]
    except struct.error:
        return
    if n > 500:
        return
    for i in range(n):
        e = offset + 2 + i * 12
        if e + 12 > len(data):
            break
        tag, typ, cnt = struct.unpack(bo + "HHI", data[e: e + 8])
        if typ not in _TYPE_SIZE:
            continue
        total = _TYPE_SIZE[typ] * cnt
        if total <= 4:
            raw = data[e + 8: e + 8 + total]
        else:
            ptr = struct.unpack(bo + "I", data[e + 8: e + 12])[0]
            if ptr + total > len(data):
                continue
            raw = data[ptr: ptr + total]
        if tag in (0x8769, 0x014A, 0x8825):
            ptr = struct.unpack(bo + "I", data[e + 8: e + 12])[0]
            if tag == 0x014A:
                for k in range(cnt):
                    sub = struct.unpack(bo + "I", raw[k * 4: k * 4 + 4])[0]
                    _read_ifd(data, bo, sub, out, depth + 1)
            else:
                _read_ifd(data, bo, ptr, out, depth + 1)
            continue
        name = _TAG_NAMES.get(tag)
        if not name or name in out:
            continue
        try:
            if typ == 2:
                out[name] = raw.split(b"\x00")[0].decode("utf-8", "ignore").strip()
            elif typ in (5, 10):
                vals = []
                for k in range(cnt):
                    num, den = struct.unpack(bo + ("II" if typ == 5 else "ii"), raw[k * 8: k * 8 + 8])
                    vals.append(num / den if den else 0.0)
                out[name] = vals[0] if len(vals) == 1 else vals
            elif typ in (3, 4, 8, 9):
                fmt = {3: "H", 4: "I", 8: "h", 9: "i"}[typ]
                vals = [struct.unpack(bo + fmt, raw[k * _TYPE_SIZE[typ]: (k + 1) * _TYPE_SIZE[typ]])[0]
                        for k in range(cnt)]
                out[name] = vals[0] if len(vals) == 1 else vals
        except (struct.error, IndexError):
            continue


def read_exif(path: str) -> Dict[str, Any]:
    try:
        with open(path, "rb") as f:
            data = f.read(512 * 1024)
    except OSError:
        return {}
    if len(data) < 8 or data[:2] not in (b"II", b"MM"):
        return {}
    bo = "<" if data[:2] == b"II" else ">"
    try:
        ifd0 = struct.unpack(bo + "I", data[4:8])[0]
    except struct.error:
        return {}
    raw: Dict[str, Any] = {}
    _read_ifd(data, bo, ifd0, raw)
    return raw


def fmt_shutter(t: Any) -> str:
    try:
        t = float(t)
    except (TypeError, ValueError):
        return "—"
    if t <= 0:
        return "—"
    if t >= 1:
        return f"{t:g}s"
    return f"1/{round(1 / t)}s"


def fmt_focal(v: Any) -> str:
    try:
        return f"{float(v):.0f}mm"
    except (TypeError, ValueError):
        return "—"


def fmt_aperture(v: Any) -> str:
    try:
        return f"f/{float(v):g}"
    except (TypeError, ValueError):
        return "—"


# --------------------------------------------------------------------------
# 解码 + 归一
# --------------------------------------------------------------------------
def decode_raw(path: str) -> np.ndarray:
    """返回线性 sRGB float32 (H,W,3)，1.0 ≈ 传感器饱和。"""
    with rawpy.imread(path) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            no_auto_bright=True,
            output_color=rawpy.ColorSpace.sRGB,
            gamma=(1, 1),
            output_bps=16,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD,
            four_color_rgb=False,
        )
    return (rgb.astype(np.float32) / 65535.0)


def normalize_white(lin: np.ndarray) -> Tuple[np.ndarray, float]:
    """高光余量归一：让 99.5 分位亮度落在 0.9，避免欠曝底片过暗。"""
    step = max(1, lin.shape[0] * lin.shape[1] // 400000)
    sample = luma(lin)[::step, ::step]
    p995 = float(np.percentile(sample, 99.5))
    gain = clamp(0.90 / max(p995, 1e-4), 0.55, 6.0)
    return lin * gain, gain


def estimate_noise(lin: np.ndarray) -> float:
    """用 MAD 估计线性域亮度噪声 sigma（高通残差的中位数绝对偏差）。"""
    step = 2
    y = luma(lin)[::step, ::step]
    res = y - uniform_filter(y, size=5, mode="reflect")
    mad = float(np.median(np.abs(res)))
    sigma = 1.4826 * mad * 1.15
    return max(sigma, 1e-4)


def scene_stats(disp: np.ndarray) -> Dict[str, float]:
    """在显示域（gamma 编码后）做直方图/色彩分析。"""
    step = max(1, disp.shape[0] * disp.shape[1] // 600000)
    small = disp[::step, ::step]
    L = luma(small)
    pcts = np.percentile(L, [1, 5, 10, 25, 50, 75, 90, 98, 99.5])
    mx = small.max(axis=2)
    mn = small.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, EPS)
    r, g, b = small[..., 0], small[..., 1], small[..., 2]
    hue = np.degrees(np.arctan2(np.sqrt(3.0) * (g - b), 2 * r - g - b))
    hue = np.mod(hue, 360.0)
    skin = (hue > 8) & (hue < 46) & (sat > 0.10) & (sat < 0.62) & (L > 0.16) & (L < 0.97)
    return {
        "p01": float(pcts[0]), "p05": float(pcts[1]), "p10": float(pcts[2]),
        "p25": float(pcts[3]), "p50": float(pcts[4]), "p75": float(pcts[5]),
        "p90": float(pcts[6]), "p98": float(pcts[7]), "p995": float(pcts[8]),
        "clipped": float((L > 0.995).mean()),
        "crushed": float((L < 0.02).mean()),
        "sat_mean": float(sat.mean()),
        "skin": float(skin.mean()),
        "means": [float(small[..., i].mean()) for i in range(3)],
    }


# --------------------------------------------------------------------------
# 自动参数
# --------------------------------------------------------------------------
def auto_balance(st: Dict[str, float]) -> Dict[str, float]:
    """从场景统计反推一组保守的自然风格参数。"""
    med = clamp(st["p50"], 0.05, 0.95)
    # 死区：中位亮度落在 [0.36, 0.52] 时几乎不动，避免把正常曝光压暗/提亮过头
    target = clamp(med, 0.36, 0.52)
    ev = clamp(math.log2((target / med) ** 2.2) * 0.85, -0.55, 0.85)

    # 白平衡：灰世界微调，只允许 ±10，避免毁掉暖调/日落
    means = st["means"]
    g_rb = math.log2(max(means[0], 1e-4) / max(means[2], 1e-4))
    temp = clamp(-g_rb * 22.0, -8.0, 8.0)
    tint = clamp((means[1] - (means[0] + means[2]) / 2) * 80.0, -6.0, 6.0)

    shadows = clamp(4.0 + (0.27 - st["p25"]) * 145.0, 0.0, 46.0)
    highlights = -clamp((st["p98"] - 0.90) * 200.0, 0.0, 38.0)
    contrast = clamp(16.0 + (st["p90"] - st["p10"] - 0.42) * 42.0, 10.0, 27.0)
    midtone = clamp(4.0 + (0.47 - med) * 90.0, -6.0, 20.0)

    skin = st["skin"]
    vibrance = 21.0 * (1.0 - min(skin * 1.8, 0.40))
    # 黑场被"灰雾"抬起（隔着玻璃/雾霾）时，加大清晰度把层次拉回来
    haze = clamp((st["p05"] - 0.10) * 78.0, 0.0, 24.0)
    clarity = 13.0 * (1.0 - min(skin * 2.2, 0.55)) + haze
    saturation = 3.0

    return {
        "ev": round(ev, 2),
        "contrast": round(contrast, 1),
        "highlights": round(highlights, 1),
        "shadows": round(shadows, 1),
        "midtone": round(midtone, 1),
        "temp": round(temp, 1),
        "tint": round(tint, 1),
        "shadowTint": 0.0,
        "highlightTint": 0.0,
        "saturation": round(saturation, 1),
        "vibrance": round(vibrance, 1),
        "clarity": round(clarity, 1),
        "denoise": 0.0,   # 由噪声估计填充
        "sharpen": 0.0,
    }


def auto_detail(sigma: float, iso: float) -> Dict[str, float]:
    # sigma 是线性域噪声；映射到 0-100 的去噪强度
    d = clamp((sigma - 0.0010) * 2900.0, 6.0, 78.0)
    if iso >= 3200:
        d = max(d, clamp(45.0 + (iso - 3200) / 90.0, 45.0, 78.0))
    elif iso >= 1600:
        d = max(d, 38.0)
    # 降噪后补偿一点锐化，找回 micro-contrast
    sh = clamp(32.0 + d * 0.18 - 9.0 * clamp((iso - 1600) / 6000.0, 0, 1), 20.0, 46.0)
    return {"denoise": round(d, 1), "sharpen": round(sh, 1)}


def soften_for_develop(base: Dict[str, float]) -> Dict[str, float]:
    """
    darktable 显影出来的底片已经做过曝光补偿、色调映射和降噪，
    这边的自动调色只做"轻推"，否则两层处理叠加会导致高光发灰、暗部糊死。
    """
    q = dict(base)
    for k, f in (
        ("ev", 0.55), ("contrast", 0.55), ("shadows", 0.6), ("highlights", 0.6),
        ("midtone", 0.65), ("clarity", 0.55), ("vibrance", 0.85),
        ("saturation", 0.85), ("temp", 0.7), ("tint", 0.7),
    ):
        q[k] = round(q[k] * f, 1)
    q["denoise"] = round(min(q["denoise"] * 0.28, 18.0), 1)
    q["sharpen"] = round(min(q["sharpen"] * 0.75, 30.0), 1)
    return q


def preview_data_uri(arr: np.ndarray, edge: int = 480, quality: int = 70) -> str:
    """把成品压成一张小图塞进 manifest，供相册网格/胶片条直接显示，
    这样输出目录里就只需要每张 RAW 一个 jpg。"""
    h, w = arr.shape[:2]
    scale = edge / max(h, w)
    tw, th = max(1, round(w * scale)), max(1, round(h * scale))
    img = Image.fromarray((np.clip(arr, 0, 1) * 255.0 + 0.5).astype(np.uint8), mode="RGB")
    if scale < 1:
        img = img.resize((tw, th), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True, subsampling=2)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------
# 降噪：à trous 小波（与 darktable 的 profiled denoise 同一套原理）
# --------------------------------------------------------------------------
B3_SPLINE = np.array([1, 4, 6, 4, 1], dtype=np.float32) / 16.0
# B3 核的能量：Σkᵢ² = 70/256，白噪声经一级低通后方差衰减到 0.273 倍，
# 因此第 k 级细节带的标准差系数依次为 0.852 / 0.446 / 0.233 / 0.122
SCALE_SIGMA = (0.852, 0.446, 0.233)


def _atrous_blur(img: np.ndarray, step: int) -> np.ndarray:
    """à trous（带孔）B3 样条低通：核固定、间距随尺度翻倍。"""
    k = np.zeros(4 * step + 1, dtype=np.float32)
    k[::step] = B3_SPLINE
    out = correlate1d(img, k, axis=0, mode="nearest")
    return correlate1d(out, k, axis=1, mode="nearest")


def wavelet_denoise_plane(plane: np.ndarray, sigma: float, strength: float,
                          chroma: bool = False) -> np.ndarray:
    """
    软阈值小波降噪。strength: 0..1。
    色度通道阈值放大：人眼对色度噪声宽容，对色度细节不敏感。
    """
    if strength <= 0.02 or sigma <= 0:
        return plane
    tf = (0.55 + 1.85 * strength) * (2.4 if chroma else 1.0)
    out = np.zeros_like(plane)
    cur = plane
    for i, step in enumerate((1, 2, 4)):
        low = _atrous_blur(cur, step)
        detail = cur - low
        thr = SCALE_SIGMA[i] * sigma * tf
        absd = np.abs(detail)
        absd -= thr
        np.maximum(absd, 0.0, out=absd)
        # 软阈值保留符号，避免硬阈值的"塑料感"
        np.copysign(absd, detail, out=absd)
        out += absd
        cur = low
        del low, detail
    out += cur
    return out


def denoise_linear(lin: np.ndarray, sigma: float, strength: float) -> np.ndarray:
    """亮度 + 色度分离的小波降噪（对应 darktable profiled denoise 的 wavelet 模式）。"""
    if strength <= 0.02:
        return lin
    Y = luma(lin)
    cb = lin[..., 2] - Y
    cr = lin[..., 0] - Y

    Y_out = wavelet_denoise_plane(Y, sigma, strength, chroma=False)
    cb = wavelet_denoise_plane(cb, sigma, strength, chroma=True)
    cr = wavelet_denoise_plane(cr, sigma, strength, chroma=True)

    out = np.empty_like(lin)
    B = Y_out + cb
    R = Y_out + cr
    G = (Y_out - LUMA_W[0] * R - LUMA_W[2] * B) / LUMA_W[1]
    out[..., 0] = R
    out[..., 1] = G
    out[..., 2] = B
    return np.clip(out, 0.0, 1.2)


def highlight_rolloff(lin: np.ndarray, white: float) -> np.ndarray:
    """
    darktable sigmoid / filmic 的肩部：扩展 Reinhard。
    中灰 0.18 保持不变，white 点映射到 1.0，以上部分平滑渐进到 1.0 而不硬切。
    """
    w = max(white, 0.25)
    return lin * (1.0 + lin / (w * w)) / (1.0 + lin)


# --------------------------------------------------------------------------
# darktable 后端：把 RAW 显影交给 darktable，我们只做自动调色
# --------------------------------------------------------------------------
DT_CANDIDATES = (
    "/usr/bin/darktable-cli",
    "/usr/local/bin/darktable-cli",
    "/snap/bin/darktable-cli",
    "/var/lib/flatpak/exports/bin/org.darktable.Darktable",
    "/app/bin/darktable-cli",
)


def find_darktable(explicit: Optional[str] = None) -> Optional[str]:
    """按显式路径 → 环境变量 → PATH → 常见安装位置 的顺序找 darktable-cli。"""
    for c in (explicit, os.environ.get("DARKTABLE_CLI")):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    w = shutil.which("darktable-cli")
    if w:
        return w
    for c in DT_CANDIDATES:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def darktable_develop(raw_path: str, out_path: str, long_edge: int, dt_bin: str,
                      style: Optional[str] = None, timeout: int = 300) -> bool:
    """
    调 darktable-cli 用它的默认流水线显影一张底片：
    自带去马赛克、镜头校正、相机噪声配置文件降噪、色调映射。
    产出 8bit sRGB JPEG，交给后续的自动调色。

    不写 XMP：darktable 的模块参数是二进制结构体，跨版本手写极易出错，
    这里只要求"一份高质量的默认显影"，风格调整仍由 xphoto 负责。

    注意 4.6 的 CLI 形如 `darktable-cli <in> <out> [--hq true]`，
    而且多个实例会争抢同一个 library.db（SQLite 锁），所以每个进程
    用一个独立的 --configdir，否则并行时会直接 abort。
    """
    cmd = [dt_bin, raw_path, out_path, "--hq", "0" if long_edge and long_edge < 1200 else "true"]
    if long_edge:
        cmd += ["--width", str(long_edge), "--height", str(long_edge)]
    if style:
        cmd += ["--style", style]
    cfg = os.path.join(tempfile.gettempdir(), f"xphoto_darktable_{os.getpid()}")
    os.makedirs(cfg, exist_ok=True)
    cmd += ["--core", "--configdir", cfg]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (subprocess.SubprocessError, OSError) as e:
        print(f"    ! darktable 调用失败：{e}", flush=True)
        return False
    if r.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
        tail = (r.stderr or b"").decode("utf-8", "ignore").strip().splitlines()[-3:]
        print(f"    ! darktable 返回 {r.returncode}：{' / '.join(tail)}", flush=True)
        return False
    return True


def load_display(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


# --------------------------------------------------------------------------
# 渲染（与 web/app.js 的 GLSL 公式一一对应）
# --------------------------------------------------------------------------
def render(neutral_disp: np.ndarray, prm: Dict[str, float], sigma: float,
           white: float = 1.0) -> np.ndarray:
    den = float(prm.get("denoise", 0)) / 100.0
    p = neutral_disp
    if den > 0.02:
        p = to_display(denoise_linear(to_linear(p), sigma, den))

    # ---- 曝光 / 白平衡 / 高光滑架（线性域）----
    lin = to_linear(p)
    lin *= np.float32(2.0 ** float(prm.get("ev", 0.0)))
    t = float(prm.get("temp", 0)) / 100.0
    ti = float(prm.get("tint", 0)) / 100.0
    lin[..., 0] *= (1.0 + 0.30 * t + 0.05 * ti)
    lin[..., 2] *= (1.0 - 0.30 * t + 0.05 * ti)
    lin[..., 1] *= (1.0 - 0.16 * ti)
    if white > 0:
        lin = highlight_rolloff(lin, white)
    p = to_display(lin)

    L = luma(p)

    # ---- 阴影提亮 / 高光回收 ----
    sh = float(prm.get("shadows", 0)) / 100.0
    if abs(sh) > 1e-3:
        w = (1.0 - smoothstep(0.0, 0.58, L))[..., None]
        p = p + sh * 0.30 * w * (1.0 - p)
    hl = float(prm.get("highlights", 0)) / 100.0
    if abs(hl) > 1e-3:
        w = smoothstep(0.36, 0.96, L)[..., None]
        p = p * (1.0 + hl * 0.34 * w)
    p = np.clip(p, 0.0, 1.0)

    # ---- 对比（S 曲线 / 反 S）----
    c = float(prm.get("contrast", 0)) / 100.0
    if abs(c) > 1e-3:
        if c > 0:
            p = p + (p * p * (3.0 - 2.0 * p) - p) * c
        else:
            p = p + (inv_smoothstep(p) - p) * (-c)

    # ---- 中间调（钟形遮罩提亮/压暗，让主体跳出来）----
    mt = float(prm.get("midtone", 0)) / 100.0
    if abs(mt) > 1e-3:
        Y = luma(p)
        bell = 1.0 - np.abs(2.0 * Y - 1.0) ** 1.7
        gain = 1.0 + mt * 0.42 * bell
        p = p * gain[..., None]

    # ---- 清晰度：双尺度局部对比（小半径=质感，大半径=去灰/通透）----
    cl = float(prm.get("clarity", 0)) / 100.0
    if abs(cl) > 1e-3:
        Y = luma(p)
        short = min(p.shape[0], p.shape[1])
        fine = np.clip(Y - box_blur(Y, max(2, short // 420), 2), -0.18, 0.18)
        broad = np.clip(Y - box_blur(Y, max(4, short // 42), 3), -0.25, 0.25)
        p = p + (cl * 1.05 * (0.55 * fine + 0.50 * broad))[..., None]

    # ---- 色彩分级（color balance rgb：阴影/高光分离色调）----
    st_amt = float(prm.get("shadowTint", 0)) / 100.0
    ht_amt = float(prm.get("highlightTint", 0)) / 100.0
    if abs(st_amt) > 1e-3 or abs(ht_amt) > 1e-3:
        Y = luma(p)
        ws = (1.0 - smoothstep(0.02, 0.55, Y))
        wh = smoothstep(0.45, 1.0, Y)
        g = st_amt * ws + ht_amt * wh
        p[..., 0] *= (1.0 + 0.14 * g)
        p[..., 2] *= (1.0 - 0.14 * g)
        p[..., 1] *= (1.0 + 0.02 * g)

    # ---- 饱和度 / 鲜艳度（肤色保护）----
    sat_amt = float(prm.get("saturation", 0)) / 100.0
    vib_amt = float(prm.get("vibrance", 0)) / 100.0
    if abs(sat_amt) > 1e-3 or abs(vib_amt) > 1e-3:
        Y = luma(p)[..., None]
        mx = p.max(axis=2)
        mn = p.min(axis=2)
        s = (mx - mn) / np.maximum(mx, EPS)
        r, g, b = p[..., 0], p[..., 1], p[..., 2]
        hue = np.mod(np.degrees(np.arctan2(np.sqrt(3.0) * (g - b), 2 * r - g - b)), 360.0)
        skin_mask = ((hue > 8) & (hue < 46) & (s > 0.1) & (s < 0.7))
        skin_w = (1.0 - 0.6 * skin_mask.astype(np.float32)).astype(np.float32)
        del r, g, b, hue, skin_mask
        gain = 1.0 + sat_amt + vib_amt * (1.0 - s) * 0.95 * skin_w
        del skin_w
        gain = np.maximum(gain, 0.0).astype(np.float32)
        p = Y + (p - Y) * gain[..., None]

    # ---- 锐化（非锐化掩膜，带光晕钳制）----
    sp = float(prm.get("sharpen", 0)) / 100.0
    if sp > 1e-3:
        Y = luma(p)
        base = box_blur(Y, 1, passes=2)
        detail = np.clip(Y - base, -0.12, 0.12)
        p = p + (detail * sp * 1.1)[..., None]

    return np.clip(p, 0.0, 1.0)


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------
def save_jpeg(arr: np.ndarray, path: str, quality: int = 92) -> None:
    img = Image.fromarray((np.clip(arr, 0, 1) * 255.0 + 0.5).astype(np.uint8), mode="RGB")
    img.save(path, "JPEG", quality=quality, subsampling=0, optimize=True)


def resize_long_edge(arr: np.ndarray, long_edge: int) -> np.ndarray:
    h, w = arr.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1:
        return arr
    img = Image.fromarray((np.clip(arr, 0, 1) * 255.0 + 0.5).astype(np.uint8), mode="RGB")
    img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    return np.asarray(img, dtype=np.float32) / 255.0


# --------------------------------------------------------------------------
# 单张处理
# --------------------------------------------------------------------------
def process_one(args: Tuple[str, str, str, Optional[str], Optional[str], int]) -> Dict[str, Any]:
    path, out_root, engine, dt_bin, dt_style, quality = args
    t0 = time.time()
    name = os.path.splitext(os.path.basename(path))[0]
    exif = read_exif(path)
    out_path = os.path.join(out_root, name + ".jpg")

    # ---- 底片：darktable 显影 或 自带线性解码 ----
    used_engine = "native"
    gain = 1.0
    white_lin = 1.0          # 0 表示"不需要线性域削顶"（底片已是显示参考）
    neutral_disp = None
    if engine in ("auto", "darktable") and dt_bin:
        tmp = os.path.join(tempfile.gettempdir(), f"xphoto_{name}_{os.getpid()}.jpg")
        try:
            if darktable_develop(path, tmp, 0, dt_bin, dt_style):
                neutral_disp = load_display(tmp)
                used_engine = "darktable"
                white_lin = 0.0
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    if neutral_disp is None:
        lin, gain = normalize_white(decode_raw(path))
        neutral_disp = np.clip(to_display(lin), 0.0, 1.0)
        sigma = estimate_noise(lin)
        try:
            white_lin = float(np.percentile(luma(lin)[::3, ::3], 99.9))
        except (IndexError, ValueError):
            white_lin = 1.0
        white_lin = clamp(white_lin, 0.2, 8.0)
        del lin
    else:
        # darktable 已用相机噪声配置文件降过噪，这里的噪声只是残差，用来定去噪强度
        sigma = estimate_noise(to_linear(neutral_disp)) * 0.55

    st = scene_stats(neutral_disp)

    try:
        iso = float(exif.get("iso", 0) or 0)
    except (TypeError, ValueError):
        iso = 0.0

    params = auto_balance(st)
    params.update(auto_detail(sigma, iso))
    if used_engine == "darktable":
        params = soften_for_develop(params)

    final = render(neutral_disp, params, sigma, white_lin)
    del neutral_disp

    save_jpeg(final, out_path, quality)
    after_stats = scene_stats(resize_long_edge(final, 900))
    preview = preview_data_uri(final)
    h, w = final.shape[:2]
    del final

    meta = {
        "id": name,
        "file": os.path.basename(path),
        "path": f"{os.path.basename(out_root)}/{name}.jpg",
        "width": w,
        "height": h,
        "engine": used_engine,
        "exif": {
            "camera": " ".join(x for x in [str(exif.get("make", "")), str(exif.get("model", ""))] if x) or "未知相机",
            "lens": str(exif.get("lens", "") or "—"),
            "iso": int(iso) if iso else None,
            "shutter": fmt_shutter(exif.get("exposure_time")),
            "aperture": fmt_aperture(exif.get("fnumber")),
            "focal": fmt_focal(exif.get("focal_length")),
            "date": str(exif.get("datetime_original") or exif.get("datetime") or "—"),
        },
        "analysis": {
            "noiseSigma": round(sigma, 5),
            "skinRatio": round(st["skin"], 3),
            "satMean": round(st["sat_mean"], 3),
            "clipped": round(st["clipped"], 4),
            "crushed": round(st["crushed"], 4),
            "whiteGain": round(gain, 3),
            "whiteLin": round(white_lin, 3),
            "medianBefore": round(st["p50"], 3),
            "medianAfter": round(after_stats["p50"], 3),
            "contrastBefore": round(st["p90"] - st["p10"], 3),
            "contrastAfter": round(after_stats["p90"] - after_stats["p10"], 3),
        },
        "params": params,        # 已烘焙进 jpg 的自动参数，网页端只用来展示
        "preview": preview,      # 小图 data URI，相册/胶片条直接用
        "procMs": int((time.time() - t0) * 1000),
    }
    print(f"  ✓ {name}  {w}x{h}  ISO{int(iso)}  噪声σ={sigma:.4f}  去噪{params['denoise']:.0f}  "
          f"{meta['procMs']}ms", flush=True)
    return meta


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
RAW_EXT = {".arw", ".srf", ".sr2", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw"}


def main() -> int:
    ap = argparse.ArgumentParser(description="RAW 自动修图流水线")
    ap.add_argument("--input", default="data", help="RAW 目录")
    ap.add_argument("--output", default="out", help="输出目录（平铺，每张 RAW 一个同名 jpg）")
    ap.add_argument("--quality", type=int, default=93, help="成品 JPEG 质量")
    ap.add_argument("--jobs", type=int, default=min(4, (os.cpu_count() or 2)), help="并行进程数")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 张（调试用）")
    ap.add_argument("--engine", choices=["darktable", "auto", "native"], default="darktable",
                    help="显影引擎：darktable=用 darktable 显影（默认），auto=有就用、没有就回退，"
                         "native=纯自带线性解码")
    ap.add_argument("--darktable", default=None, help="darktable-cli 路径（默认自动查找）")
    ap.add_argument("--dt-style", default=None, help="传给 darktable-cli 的 --style 名称")
    a = ap.parse_args()

    if rawpy is None:
        print("缺少 rawpy：pip install rawpy", file=sys.stderr)
        return 1

    dt_bin = find_darktable(a.darktable)
    engine = a.engine
    if not dt_bin:
        if engine == "darktable":
            print("没找到 darktable-cli，自动回退到自带显影引擎（native）。\n"
                  "  装一个：sudo apt install darktable\n"
                  "  或用 --darktable /path/to/darktable-cli 指定路径\n")
        engine = "native"
    elif engine == "auto":
        engine = "darktable"

    files = sorted(
        os.path.join(a.input, f) for f in os.listdir(a.input)
        if os.path.splitext(f)[1].lower() in RAW_EXT
    )
    if a.limit:
        files = files[: a.limit]
    if not files:
        print(f"{a.input} 里没有找到 RAW 文件", file=sys.stderr)
        return 1

    os.makedirs(a.output, exist_ok=True)
    print(f"发现 {len(files)} 个 RAW，开始处理 → {a.output}/  "
          f"[引擎: {engine}{' @ ' + dt_bin if engine == 'darktable' else ''}]")
    t0 = time.time()
    tasks = [(f, a.output, engine, dt_bin, a.dt_style, a.quality) for f in files]
    # rawpy 内部启用 OpenMP，必须用 spawn/forkserver 避免死锁
    import multiprocessing as mp
    ctx = mp.get_context("spawn")
    with ProcessPoolExecutor(max_workers=max(1, a.jobs), mp_context=ctx) as ex:
        metas = list(ex.map(process_one, tasks))

    used = sorted({m["engine"] for m in metas})
    manifest = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": a.input,
        "version": 3,
        "engine": used[0] if len(used) == 1 else "mixed",
        "darktable": dt_bin if "darktable" in used else None,
        "paramKeys": PARAM_KEYS,
        "paramRange": {k: list(v) for k, v in PARAM_RANGE.items()},
        "processMs": int((time.time() - t0) * 1000),
        "images": metas,
    }
    with open(os.path.join(a.output, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"完成：{len(metas)} 张，用时 {time.time() - t0:.1f}s → {a.output}/manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
