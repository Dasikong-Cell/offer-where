#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成小程序 tabBar 图标（miniprogram/images/tab-*.png）。

为什么单独一个脚本：
  tabBar 图标与 app.ico 的约束**根本不同**，不能复用 make_icon.py：
    1. 微信要求 tabBar 图标是 **PNG**，尺寸建议 81x81（我们出 81x81 一倍图 + 162x162 二倍图）；
    2. tabBar 图标**不能有底板**，只能是透明底上的单色图形 —— 而 app.ico 恰恰是
       「靛蓝渐变圆角底板 + 纯白主体」，直接缩下来会变成一块脏色方块；
    3. 需要「未选中 / 选中」两态：未选中用中性灰、选中用品牌色。
  但**绘制基线保持一致**：同样 24x24 设计坐标、同样先 1024 超采样再 LANCZOS 降采样、
  同样只用单色 + 「挖空」表达细节（不做第二种颜色），这样小尺寸下不会糊成噪点。

配色取自控制台 CSS 变量（单一真相源 public/console.html 的 --brand / --muted）：
  选中色 = #FF7A45（品牌橙，与 manifest.theme_color 一致）
  未选中 = #8A8F98（中性灰，落在微信 tabBar 默认色系里）

用法：python scripts/make_tabbar_icons.py
输出：miniprogram/images/tab-<id>.png / tab-<id>-active.png（各 81 与 162 两档）
"""
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

SS = 1024                               # supersample canvas
BRAND = (255, 122, 69, 255)             # #FF7A45 与控制台 --brand / manifest theme_color 一致
MUTED = (138, 143, 152, 255)            # #8A8F98 中性灰
CUT = (255, 255, 255, 0)                # knockout: drawn -> transparent
OUT_DIR = os.path.join(ROOT, 'miniprogram', 'images')
SIZES = [81, 162]                       # 一倍 / 二倍图

# 四个 tab 对齐控制台侧栏一级导航：首页看板 / 职位记录 / 简历中心 / 运行日志
TABS = ['dashboard', 'records', 'resume', 'logs']


def new_layer():
    return Image.new('RGBA', (SS, SS), (0, 0, 0, 0))


def grid_mapper(frac):
    """把 24x24 设计坐标映射到画布中央 frac 比例的正方形区域（与 make_icon.py 同约定）。"""
    size = SS * frac
    off = (SS - size) / 2.0

    def P(gx, gy):
        return (off + gx / 24.0 * size, off + gy / 24.0 * size)
    return P, size


# ── 首页看板：带坐标轴的趋势折线（= 控制台「首页看板」图标语义）──────────────
def ico_dashboard(color):
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.80)
    w = max(2, int(size * 0.075))
    # 圆角外框
    d.rounded_rectangle([P(2.8, 3.2), P(21.2, 20.8)],
                        radius=int(size * 0.10), outline=color, width=w)
    # 内部折线（上升趋势）
    d.line([P(6.6, 16.4), P(10.6, 12.2), P(13.6, 14.6), P(18.0, 8.8)],
           fill=color, width=w, joint='curve')
    return layer


# ── 职位记录：列表卡片（左侧竖条 + 三行）────────────────────────────────────
def ico_records(color):
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.80)
    w = max(2, int(size * 0.075))
    d.rounded_rectangle([P(2.8, 3.2), P(21.2, 20.8)],
                        radius=int(size * 0.10), outline=color, width=w)
    # 左侧分隔竖线
    d.line([P(8.6, 3.2), P(8.6, 20.8)], fill=color, width=w)
    # 右侧三行
    for gy in (8.0, 12.0, 16.0):
        d.line([P(12.0, gy), P(18.4, gy)], fill=color, width=w)
    return layer


# ── 简历中心：文档 + 折角 + 两条内容线 ──────────────────────────────────────
def ico_resume(color):
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.80)
    w = max(2, int(size * 0.075))
    # 纸张轮廓（右上折角）
    d.line([P(5.6, 2.8), P(14.0, 2.8), P(18.6, 7.4), P(18.6, 21.2), P(5.6, 21.2), P(5.6, 2.8)],
           fill=color, width=w, joint='curve')
    # 折角小三角
    d.line([P(14.0, 2.8), P(14.0, 7.4), P(18.6, 7.4)], fill=color, width=w, joint='curve')
    # 内容线
    d.line([P(9.0, 12.6), P(15.4, 12.6)], fill=color, width=w)
    d.line([P(9.0, 16.6), P(13.4, 16.6)], fill=color, width=w)
    return layer


# ── 运行日志：终端窗口（>_ 提示符）─────────────────────────────────────────
def ico_logs(color):
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.80)
    w = max(2, int(size * 0.075))
    d.rounded_rectangle([P(2.8, 4.2), P(21.2, 19.8)],
                        radius=int(size * 0.10), outline=color, width=w)
    # 标题栏横线
    d.line([P(2.8, 8.6), P(21.2, 8.6)], fill=color, width=w)
    # ">_" 提示符：尖括号 + 下划线
    d.line([P(6.6, 12.0), P(9.0, 14.4), P(6.6, 16.8)], fill=color, width=w, joint='curve')
    d.line([P(11.4, 16.8), P(16.0, 16.8)], fill=color, width=w)
    return layer


DRAWERS = {
    'dashboard': ico_dashboard,
    'records': ico_records,
    'resume': ico_resume,
    'logs': ico_logs,
}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    written = []
    for tab in TABS:
        draw = DRAWERS[tab]
        for suffix, color in (('', MUTED), ('-active', BRAND)):
            canvas = draw(color)
            for px in SIZES:
                out = os.path.join(OUT_DIR, 'tab-%s%s%s.png' % (tab, suffix, '' if px == 81 else '-2x'))
                canvas.resize((px, px), Image.LANCZOS).save(out, 'PNG', optimize=True)
                written.append(out)
                # 回读断言：尺寸必须与请求一致，且必须存在非透明像素
                with Image.open(out) as im:
                    assert im.size == (px, px), '%s size %s != %s' % (out, im.size, (px, px))
                    assert im.mode == 'RGBA', '%s mode %s != RGBA' % (out, im.mode)
                    alpha = im.getchannel('A')
                    assert alpha.getextrema()[1] > 0, '%s 全透明，图形没画上' % out
    for f in written:
        print('wrote %s (%d bytes)' % (os.path.relpath(f, ROOT), os.path.getsize(f)))
    print('共 %d 个文件' % len(written))


if __name__ == '__main__':
    main()
