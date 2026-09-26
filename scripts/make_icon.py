#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成应用图标 public/app.ico（多尺寸：16/32/48/64/128/256）。

为什么需要这个脚本：图标是二进制资产，直接塞进仓库别人无从得知它怎么来的、
也无法在换配色/换形状时复现。把它做成脚本，图标就成了可再生产物。

设计：靛蓝→蓝渐变圆角方块 + 白色纸飞机（"投递"）。先按 1024 超采样绘制再
降采样，保证 16px 这种小尺寸也不糊（小尺寸最容易被糊成一团色块）。

用法：python scripts/make_icon.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'app.ico')

SS = 1024                     # supersample canvas
TOP = (79, 70, 229)           # indigo-600
BOT = (37, 99, 235)           # blue-600
RADIUS = 0.22                 # rounded square corner ratio


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


def draw_plane(d, box, color=(255, 255, 255, 255)):
    """Feather 'send' 图标的纸飞机：M22 2 L15 22 L11 13 L2 9 Z + 折线 M22 2 L11 13"""
    x0, y0, w, h = box
    s = min(w, h)

    def P(gx, gy):
        return (x0 + gx / 24.0 * s, y0 + gy / 24.0 * s)

    d.polygon([P(22, 2), P(15, 22), P(11, 13), P(2, 9)], fill=color)
    d.line([P(22, 2), P(11, 13)], fill=color, width=max(2, int(s * 0.075)))


def main():
    bg = gradient(SS, TOP, BOT).convert('RGBA')
    mask = rounded_mask(SS, RADIUS)
    bg.putalpha(mask)

    canvas = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), bg)

    # 纸飞机居中，占 58%
    pw = int(SS * 0.58)
    off = (SS - pw) // 2
    draw_plane(ImageDraw.Draw(canvas), (off, off, pw, pw))

    sizes = [16, 32, 48, 64, 128, 256]
    frames = [canvas.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[0].save(OUT, format='ICO', sizes=[(s, s) for s in sizes],
                   append_images=frames[1:])
    print('wrote %s (%d bytes) sizes=%s' % (OUT, os.path.getsize(OUT), sizes))


if __name__ == '__main__':
    main()
