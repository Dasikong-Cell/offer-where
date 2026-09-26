#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图标候选方案生成器（设计稿阶段专用，不参与打包）。

为什么单独一个脚本：
  scripts/make_icon.py 只负责产出“选定”的 public/app.ico；在挑选阶段需要同时
  渲染多个方案、并且在 16px 这种极小尺寸下横向对比辨认度（很多图形在 256px 好看，
  缩到 16px 就糊成一团）。本脚本产出 n 个候选的 PNG 预览 + ICO + 一个画廊页面，
  选定后用 make_icon.py 复刻该方案即可，避免把实验过程混进正式产物。

绘制约定（保证所有候选在同一视觉基线上）：
  - 同一块靛蓝→蓝渐变圆角底板（#4F46E5 → #2563EB，圆角 22%）
  - 主体统一用**纯白**，是在任意深浅背景上都稳的最简解法
  - 细节纹样（简历横线、对勾）用“挖空”（画 alpha=0）而不是上第二种颜色，
    这样从 16px 到 256px 都只有两级对比，不会在小尺寸变成噪点
  - 先 1024 超采样再 LANCZOS 降采样

用法：
  <系统的 Python 3.9（装有 Pillow）> scripts/icon_candidates.py
输出：
  design/icon-cand-<id>.png  512 预览
  design/icon-cand-<id>.ico  可直接替换 public/app.ico 的成品
  design/icon-gallery.html   多尺寸对比画廊
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from ico_pack import write_ico      # noqa: E402

DESIGN = os.path.join(ROOT, 'design')
os.makedirs(DESIGN, exist_ok=True)

SS = 1024                      # supersample canvas
TOP = (79, 70, 229)            # indigo-600
BOT = (37, 99, 235)            # blue-600
RADIUS = 0.22                  # rounded square corner ratio
WHITE = (255, 255, 255, 255)
CUT = (255, 255, 255, 0)       # knockout: drawn -> transparent, lets the bg show through
CN_FONT = r'C:\Windows\Fonts\msyhbd.ttc'   # 微软雅黑 Bold


# ── 底板 ──────────────────────────────────────────────────────────────────────
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


def bg_layer():
    bg = gradient(SS, TOP, BOT).convert('RGBA')
    bg.putalpha(rounded_mask(SS, RADIUS))
    return bg


def new_layer():
    return Image.new('RGBA', (SS, SS), (0, 0, 0, 0))


def grid_mapper(frac):
    """把 24x24 设计坐标映射到画布中央 frac 比例的正方形区域。"""
    size = SS * frac
    off = (SS - size) / 2.0

    def P(gx, gy):
        return (off + gx / 24.0 * size, off + gy / 24.0 * size)
    return P, size


# ── 候选 A：纸飞机（= 现有图标）────────────────────────────────────────────
def cand_plane():
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.58)
    d.polygon([P(22, 2), P(15, 22), P(11, 13), P(2, 9)], fill=WHITE)
    d.line([P(22, 2), P(11, 13)], fill=WHITE, width=max(2, int(size * 0.075)))
    return layer


# ── 候选 B：中文「投」字（识别成本最低的一档）───────────────────────────────
def cand_cn():
    return cand_hanzi('投', 0.52)


def cand_hanzi(ch, frac):
    """中文字标：用字号把字撑到接近设计框，再按真实墨迹 bbox 居中
    （字形自带边距，不做的话会偏）。"""
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(frac)
    font = ImageFont.truetype(CN_FONT, int(size * 1.25))
    bbox = d.textbbox((0, 0), ch, font=font)
    iw, ih = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx, cy = P(12, 12)
    d.text((cx - iw / 2 - bbox[0], cy - ih / 2 - bbox[1]), ch, font=font, fill=WHITE)
    return layer


# ── 候选 C：信封（投递/沟通）────────────────────────────────────────────────
def cand_envelope():
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.68)
    w = max(2, int(size * 0.03))

    body = [P(2.6, 7.0), P(21.4, 7.0), P(21.4, 17.4), P(2.6, 17.4)]
    d.polygon(body, fill=WHITE)
    d.line([body[0], body[1], body[2], body[3], body[0]], fill=WHITE, width=w, joint='curve')
    # 开口：一个向下深入的信封口（挖空）+ 两侧封线，缩到 16px 仍是一个明确的 V
    d.polygon([P(2.6, 7.0), P(12.0, 13.6), P(21.4, 7.0)], fill=CUT)
    d.line([P(2.6, 7.0), P(12.0, 13.6), P(21.4, 7.0)], fill=WHITE, width=w, joint='curve')
    return layer


# ── 候选 D：公文包 + 挖空对勾（= offer）────────────────────────────────────
def cand_briefcase():
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.68)

    # 提手
    d.polygon([P(9.2, 8.2), P(9.2, 5.2), P(14.8, 5.2), P(14.8, 8.2)],
              fill=WHITE)
    d.polygon([P(10.6, 8.2), P(10.6, 6.6), P(13.4, 6.6), P(13.4, 8.2)],
              fill=CUT)
    # 箱体
    d.rounded_rectangle([P(2.8, 8.6), P(21.2, 18.6)],
                        radius=int(size * 0.06), fill=WHITE)
    # 对勾挖空：留出箱体底色，比再叠一层颜色更干净
    d.line([P(8.2, 13.8), P(11.2, 16.4), P(16.6, 10.8)],
           fill=CUT, width=max(3, int(size * 0.085)), joint='curve')
    return layer


CANDIDATES_R1 = [
    ('plane',     'A 纸飞机',     '发送 / 一键投递 —— 沿用现方案做对照基线', cand_plane),
    ('cn',        'B 汉字「投」', '中文母语识别成本最低，16px 也绝对清楚',    cand_cn),
    ('envelope',  'C 信封',       '投递 + 沟通，暗示 BOSS 打招呼/自动回复',   cand_envelope),
    ('briefcase', 'D 公文包对勾', '结果导向：拿到 offer',                    cand_briefcase),
]


# ── 第二轮：差异更大的五个方向 ────────────────────────────────────────────────
def cand_robot():
    """AI Agent 拟物：圆脸 + 天线 + 挖空眼睛（16px 靠两颗眼睛仍然成立）。"""
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.68)
    # 天线
    d.line([P(12, 7.2), P(12, 4.4)], fill=WHITE, width=max(3, int(size * 0.05)))
    d.ellipse([P(10.9, 3.0), P(13.1, 5.2)], fill=WHITE)
    # 耳朵
    d.rounded_rectangle([P(2.6, 10.8), P(4.8, 15.6)], radius=int(size * 0.02), fill=WHITE)
    d.rounded_rectangle([P(19.2, 10.8), P(21.4, 15.6)], radius=int(size * 0.02), fill=WHITE)
    # 脸
    d.rounded_rectangle([P(4.8, 7.2), P(19.2, 19.2)], radius=int(size * 0.10), fill=WHITE)
    # 眼睛 + 嘴（挖空）
    r = size * 0.022
    d.ellipse([P(8.9 - 1.7, 12.2 - 1.7), P(8.9 + 1.7, 12.2 + 1.7)], fill=CUT)
    d.ellipse([P(15.1 - 1.7, 12.2 - 1.7), P(15.1 + 1.7, 12.2 + 1.7)], fill=CUT)
    d.line([P(9.4, 16.2), P(14.6, 16.2)], fill=CUT, width=max(2, int(size * 0.035)))
    return layer


def cand_pin():
    """地图定位针：offer-where = “offer 在哪儿”，一眼点题；16px 下针形最稳。"""
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.68)
    # 针头（圆）+ 针尾（三角）融合成一个实心形状
    d.ellipse([P(6.6, 3.4), P(17.4, 14.2)], fill=WHITE)
    d.polygon([P(7.9, 11.6), P(16.1, 11.6), P(12.0, 20.6)], fill=WHITE)
    # 中心挖空圆孔
    d.ellipse([P(9.9, 6.7), P(14.1, 10.9)], fill=CUT)
    return layer


def cand_rocket():
    """竖直火箭 + 尾焰：上岸 / 起飞。竖直比 45° 斜放在小尺寸下轮廓更完整。"""
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.68)
    # 箭体（上半用椭圆收头）
    d.ellipse([P(8.4, 3.6), P(15.6, 10.4)], fill=WHITE)
    d.rectangle([P(8.4, 7.0), P(15.6, 15.2)], fill=WHITE)
    # 尾翼
    d.polygon([P(8.4, 11.4), P(5.2, 16.8), P(8.4, 16.2)], fill=WHITE)
    d.polygon([P(15.6, 11.4), P(18.8, 16.8), P(15.6, 16.2)], fill=WHITE)
    # 舷窗（挖空）
    d.ellipse([P(10.3, 7.6), P(13.7, 11.0)], fill=CUT)
    # 尾焰（与箭体留一道缝，避免糊成一坨）
    d.polygon([P(10.1, 16.2), P(13.9, 16.2), P(12.0, 20.8)], fill=WHITE)
    return layer


def cand_zhi():
    """汉字「职」：与 B 同管线，落在「找工作」本身。"""
    return cand_hanzi('职', 0.52)


def cand_bubble():
    """对话气泡 + 挖空三个点：自动打招呼 / AI 自动回复。16px 三点退化为一个点也不难看。"""
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    P, size = grid_mapper(0.68)
    d.rounded_rectangle([P(3.6, 4.6), P(20.4, 16.4)], radius=int(size * 0.09), fill=WHITE)
    d.polygon([P(8.6, 15.6), P(13.4, 15.6), P(7.4, 20.8)], fill=WHITE)
    r = size * 0.016
    for gx in (8.4, 12.0, 15.6):
        d.ellipse([P(gx - 1.1, 10.5 - 1.1), P(gx + 1.1, 10.5 + 1.1)], fill=CUT)
    return layer


CANDIDATES_R2 = [
    ('robot',   'E 机器人',   'AI Agent 拟物，工具感/亲和力最强',        cand_robot),
    ('pin',     'F 定位针',   '点题「offer 在哪儿」，双关定位',          cand_pin),
    ('rocket',  'G 火箭',     '上岸 / 起飞，结果与速度感',              cand_rocket),
    ('zhi',     'H 汉字「职」', '与 B 同风格，落在找工作本身',            cand_zhi),
    ('bubble',  'I 消息气泡', '自动打招呼 / AI 自动回复',               cand_bubble),
]

CANDIDATES = CANDIDATES_R1

SIZES = [16, 32, 48, 64, 128, 256]


def multi_size_ico(canvas, path):
    return write_ico(canvas, path, SIZES)


def main(round_no=1):
    cands = CANDIDATES_R1 if round_no == 1 else CANDIDATES_R2
    bg = bg_layer()
    rows = []
    for cid, name, pitch, fn in cands:
        canvas = Image.alpha_composite(bg, fn())
        ico = os.path.join(DESIGN, 'icon-cand-%s.ico' % cid)
        png = os.path.join(DESIGN, 'icon-cand-%s.png' % cid)
        multi_size_ico(canvas, ico)
        canvas.resize((512, 512), Image.LANCZOS).save(png)
        rows.append((cid, name, pitch, os.path.getsize(ico)))
        print('%-12s %-14s ico=%d B' % (cid, name, os.path.getsize(ico)))

    html = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
            '<title>图标候选对比</title>',
            '<style>',
            'body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f6f7fb;color:#1f2430;margin:0;padding:28px}',
            'h1{font-size:20px;margin:0 0 4px}p.lead{color:#5b6478;margin:0 0 24px;font-size:13px}',
            '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}',
            '.card{background:#fff;border:1px solid #e3e6f0;border-radius:14px;padding:18px}',
            '.card h2{font-size:15px;margin:0 0 4px}.card .pitch{color:#5b6478;font-size:12px;margin:0 0 14px;line-height:1.5}',
            '.row{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}',
            '.slot{text-align:center}.slot span{display:block;color:#8a92a6;font-size:11px;margin-top:6px}',
            '.check{display:flex;gap:6px;margin-top:14px}',
            '.sw{width:44px;height:44px;border-radius:8px}',
            '.lg{background:#fff;border:1px solid #e3e6f0}.dk{background:#2a2f45;border:1px solid #3a4160}',
            '</style></head><body>',
            '<h1>应用图标候选方案（第 %d 轮）</h1>' % round_no,
            '<p class="lead">重点看 <b>16px 与 24px 那两列</b> —— 曲面/纤细线条在这个尺寸会糊成一团，那是桌面任务栏和标签页真实渲染的大小。</p>',
            '<div class="grid">']
    for cid, name, pitch, _ in rows:
        html.append('<div class="card">')
        html.append('<h2>%s</h2><div class="pitch">%s</div>' % (name, pitch))
        html.append('<div class="row">')
        for s in (128, 48, 24, 16):
            html.append('<div class="slot"><img src="icon-cand-%s.png" width="%d" height="%d">'
                        '<span>%dpx</span></div>' % (cid, s, s, s))
        html.append('</div>')
        html.append('<div class="check"><div class="sw lg"><img src="icon-cand-%s.png" width="44" height="44"></div>'
                    '<div class="sw dk"><img src="icon-cand-%s.png" width="44" height="44"></div>'
                    '<div class="sw" style="background:#f6f7fb"><img src="icon-cand-%s.png" width="44" height="44"></div></div>'
                    % (cid, cid, cid))
        html.append('</div>')
    html.append('</div></body></html>')

    gallery = os.path.join(DESIGN, 'icon-gallery-r%d.html' % round_no)
    with open(gallery, 'w', encoding='utf-8') as f:
        f.write('\n'.join(html))
    print('gallery ->', gallery)


if __name__ == '__main__':
    import sys
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
