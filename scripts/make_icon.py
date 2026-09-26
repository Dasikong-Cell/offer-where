#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成应用图标 public/app.ico（多尺寸：16/32/48/64/128/256）。

为什么需要这个脚本：图标是二进制资产，直接塞进仓库别人无从得知它怎么来的、
也无法在换配色/换形状时复现。把它做成脚本，图标就成了可再生产物。

设计（2026-09-26 用户从两轮 9 个候选中选定）：
  靛蓝→蓝渐变圆角方块 + 白色对话气泡（挖空三个点）。
  含义：自动打招呼 / AI 自动回复 —— 这个应用每天做得最多的就是「替你和 HR 说话」。
  备选方案的绘制与多尺寸对比脚本在 scripts/icon_candidates.py，
  对比画廊在 design/icon-gallery-r1.html / -r2.html。

工程约定：
  - 主体只用纯白一种颜色，细节纹样用「挖空」（alpha=0）而不是第二种颜色，
    保证 16px 到 256px 只有两级对比，不会在小尺寸变成噪点
  - 先按 1024 超采样绘制再 LANCZOS 降采样，16px 也不糊

用法：python scripts/make_icon.py
"""
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from ico_pack import write_ico, read_ico_frames   # noqa: E402

SS = 1024                     # supersample canvas
TOP = (79, 70, 229)           # indigo-600
BOT = (37, 99, 235)           # blue-600
RADIUS = 0.22                 # rounded square corner ratio
WHITE = (255, 255, 255, 255)
CUT = (255, 255, 255, 0)      # knockout: drawn -> transparent, lets the bg show through
OUT = os.path.join(ROOT, 'public', 'app.ico')
SIZES = [16, 32, 48, 64, 128, 256]


def rounded_mask(size, radius_ratio):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return m


def gradient(size, top, bot):
    g = Image.new('RGB', (1, size))
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    return g.resize((size, size))


def draw_bubble(d, box):
    """24x24 设计坐标：圆角气泡 (3.6,4.6)-(20.4,16.4) + 左下尾巴 + 三个挖空点。"""
    x0, y0, w, h = box
    s = min(w, h)

    def P(gx, gy):
        return (x0 + gx / 24.0 * s, y0 + gy / 24.0 * s)

    d.rounded_rectangle([P(3.6, 4.6), P(20.4, 16.4)],
                        radius=int(s * 0.09), fill=WHITE)
    d.polygon([P(8.6, 15.6), P(13.4, 15.6), P(7.4, 20.8)], fill=WHITE)
    for gx in (8.4, 12.0, 15.6):
        d.ellipse([P(gx - 1.1, 10.5 - 1.1), P(gx + 1.1, 10.5 + 1.1)], fill=CUT)


def main():
    bg = gradient(SS, TOP, BOT).convert('RGBA')
    bg.putalpha(rounded_mask(SS, RADIUS))

    canvas = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), bg)

    # 气泡居中，占 68%（与候选管线一致）
    bw = int(SS * 0.68)
    off = (SS - bw) // 2
    draw_bubble(ImageDraw.Draw(canvas), (off, off, bw, bw))

    # 输入必须是 SS×SS，write_ico 内部按需缩到各档（并回读断言帧数）
    n = write_ico(canvas, OUT, SIZES)
    frames = read_ico_frames(OUT)
    print('wrote %s (%d bytes) frames=%s' % (OUT, n, frames))
    # 双保险：尺寸清单写死在脚本里，产物必须与之完全一致
    assert frames == SIZES, 'icons frames mismatch: %s != %s' % (frames, SIZES)


if __name__ == '__main__':
    main()
