#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 public/app.ico 派生 PWA 图标（PNG），单一真相源仍然是 app.ico。

为什么不让 PWA 直接用 app.ico：
  manifest 的 icons 虽然允许 .ico，但 **Android/Chrome 只认 PNG**（规范里 ico 被视为
  legacy，Chromium 会拒绝把 .ico 当 maskable 图标用），iOS Safari 的 apple-touch-icon
  同样只吃 PNG。所以必须派生 PNG，且要回读断言尺寸 —— 与 ico_pack.py 同一套 fail-closed 思路。

产出：
    public/pwa-192.png           192x192  （Android 主屏 / 通用）
    public/pwa-512.png           512x512  （启动画面 / 商店）
    public/pwa-maskable-512.png  512x512  （Android 自适应图标，内容缩到 80% 留安全边距）
    public/apple-touch-icon.png  180x180  （iOS 添加到主屏幕）

用法：
    python scripts/pwa_icons.py            # 生成 + 回读断言
    python scripts/pwa_icons.py --check    # 只回读断言，不重新生成（CI 用）
"""
import os
import sys
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, 'public')
SRC_ICO = os.path.join(PUBLIC, 'app.ico')

# (输出文件名, 边长, 是否做 maskable 安全边距)
TARGETS = [
    ('pwa-192.png', 192, False),
    ('pwa-512.png', 512, False),
    ('pwa-maskable-512.png', 512, True),
    ('apple-touch-icon.png', 180, False),
]

MASKABLE_INSET = 0.80   # maskable 规范要求内容集中在中心 80% 的「安全区」内


def _read_largest_ico_frame(path):
    """取 ICO 里**面积最大**的一帧解码为 RGBA。

    不能直接 Image.open(path) —— Pillow 的 IcoImagePlugin 默认会给**第一帧**，
    而 ico_pack.py 是按尺寸升序写入的，第一帧是 16x16，放大后必糊。
    """
    from PIL import Image
    import io

    img = Image.open(path)
    best = None
    best_area = -1
    try:
        n = getattr(img, 'n_frames', 1)
        for i in range(n):
            img.seek(i)
            area = img.size[0] * img.size[1]
            if area > best_area:
                best_area = area
                best = img.convert('RGBA').copy()
    finally:
        img.close()
    if best is None:
        raise RuntimeError('ICO 里没读到任何帧：%s' % path)
    return best


def _read_png_size(path):
    """直接从 PNG 文件头取宽高（IHDR），不依赖 Pillow —— 用于回读断言。"""
    with open(path, 'rb') as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('不是合法 PNG：%s' % path)
    w, h = struct.unpack('>II', head[16:24])
    return w, h


def _read_png_is_rgba(path):
    """读 IHDR 的 color type（6 = truecolor+alpha）与 bit depth。"""
    with open(path, 'rb') as f:
        head = f.read(26)
    bit_depth = head[24]
    color_type = head[25]
    return bit_depth, color_type


def generate():
    from PIL import Image

    src = _read_largest_ico_frame(SRC_ICO)
    print('源图标 app.ico 最大帧：%dx%d' % src.size)
    if src.size[0] < 256:
        raise RuntimeError('app.ico 最大帧只有 %dpx，不足以派生 512 图标' % src.size[0])

    made = []
    for name, size, maskable in TARGETS:
        out = os.path.join(PUBLIC, name)
        if maskable:
            inner = int(round(size * MASKABLE_INSET))
            art = src.resize((inner, inner), Image.LANCZOS)
            # 底色取源图四角之中出现最多的不透明像素，保证 maskable 被裁成圆形后不出透明边
            bg = _corner_bg(src)
            canvas = Image.new('RGBA', (size, size), bg)
            off = (size - inner) // 2
            canvas.paste(art, (off, off), art)
            canvas.save(out, format='PNG', optimize=True)
        else:
            src.resize((size, size), Image.LANCZOS).save(out, format='PNG', optimize=True)
        made.append((name, size, maskable))
        print('  写出 %-24s %dx%d%s' % (name, size, size, ' (maskable)' if maskable else ''))

    assert_all(want=made)
    return made


def _corner_bg(img):
    """从四角采样：取第一个不透明像素当底色；全透明则退回品牌橙。"""
    w, h = img.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        r, g, b, a = img.getpixel(xy)
        if a > 200:
            return (r, g, b, 255)
    return (255, 122, 69, 255)


def assert_all(want=None):
    """回读断言：每个目标 PNG 必须存在、尺寸精确、带 alpha（fail-closed）。"""
    targets = want if want is not None else TARGETS
    bad = []
    for name, size, _maskable in targets:
        path = os.path.join(PUBLIC, name)
        if not os.path.exists(path):
            bad.append('%s 不存在' % name)
            continue
        w, h = _read_png_size(path)
        if (w, h) != (size, size):
            bad.append('%s 尺寸 %dx%d，期望 %dx%d' % (name, w, h, size, size))
        bit_depth, color_type = _read_png_is_rgba(path)
        if color_type != 6:
            bad.append('%s color_type=%d（期望 6 = RGBA）' % (name, color_type))
        size_bytes = os.path.getsize(path)
        if size_bytes < 400:
            bad.append('%s 只有 %d 字节，疑似空图' % (name, size_bytes))
    if bad:
        raise AssertionError('PWA 图标回读断言失败：\n  - ' + '\n  - '.join(bad))
    print('回读断言通过：%d 个 PNG 尺寸/通道/非空全部正确' % len(targets))


def main():
    if '--check' in sys.argv:
        assert_all()
        return
    generate()


if __name__ == '__main__':
    main()
