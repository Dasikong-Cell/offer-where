#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ICO 封装（自己实现，不依赖 Pillow 的 ICO 保存路径）。

为什么不用 `img.save(path, format='ICO', sizes=[...], append_images=[...])`：
  Pillow 的 IcoImagePlugin._save 里有这么一句判断（PIL 11.3 第 54 行）

      width, height = im.size          # 取的是「基准图」尺寸
      for size in sorted(set(sizes)):
          if size[0] > width or size[1] > height: continue

  也就是说，基准图必须和 sizes 里最大的那一档一样大，否则更大的档位会被**静默跳过**。
  如果按「小到大」传（frames[0] = 16px 当基准），结果是一个只有 16x16 一帧的 ICO ——
  文件能生成、大小看着正常、Windows 也能显示，只是在 32/48/256px 上把 16px 拉大，
  于是图标永远是糊的。这个坑不会报任何错，只能靠「解码回来数帧」发现。

  所以这里自己写封装：帧格式明确（小尺寸用 DIB、256 用 PNG，与主流图标工具一致），
  并且 write_ico() 写完立刻把文件读回来断言帧数 —— fail-closed，不给静默回归的机会。

用法：
    from ico_pack import write_ico, read_ico_frames
    write_ico(canvas_rgba, 'public/app.ico', [16, 32, 48, 64, 128, 256])
"""
import struct

PNG_FROM = 256        # 该尺寸及以上用 PNG 压缩存储（体积从 264KB 降到几 KB）
MAX_FRAME = 256       # ICO 格式上限；256 在目录里用 0 表示


def _dib(img):
    """32bpp DIB 帧：BITMAPINFOHEADER + 自下而上的 BGRA 位图 + 1bpp AND 掩码。"""
    w, h = img.size
    px = img.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):          # BMP 位图自下而上存储
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        xor += row
    # AND 掩码：有 alpha 通道时全 0 即可，但部分老渲染器要求它存在，每行按 4 字节对齐
    and_row = b'\x00' * (((w + 31) // 32) * 4)
    and_mask = and_row * h
    # 注意高度要写 2*h（XOR + AND 两张位图叠起来的高度）
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    return header + bytes(xor) + and_mask


def _png(img):
    import io
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def write_ico(canvas, path, sizes):
    """把一张 RGBA 画布写成多尺寸 ICO，并回读断言（帧数/尺寸完全一致才返回）。"""
    frames = []
    for s in sorted(set(sizes)):
        if s > MAX_FRAME:
            raise ValueError('ICO 最大支持 256，收到 %d' % s)
        img = canvas.resize((s, s)) if canvas.size != (s, s) else canvas
        img = img.convert('RGBA')
        frames.append((s, _png(img) if s >= PNG_FROM else _dib(img)))

    out = bytearray()
    out += struct.pack('<HHH', 0, 1, len(frames))          # reserved / type=icon / count
    offset = 6 + 16 * len(frames)
    for s, data in frames:
        out += struct.pack('<BBBBHHII',
                           0 if s >= 256 else s,           # 256 在目录里记 0
                           0 if s >= 256 else s,
                           0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in frames:
        out += data

    with open(path, 'wb') as f:
        f.write(bytes(out))

    got = read_ico_frames(path)
    want = sorted(set(sizes))
    if got != want:
        raise AssertionError('ICO 写入后回读不一致：期望 %s，实际 %s（%s）'
                             % (want, got, path))
    return len(out)


def read_ico_frames(path):
    """回读 ICO 目录，返回实际帧尺寸列表（用于断言与排查）。"""
    with open(path, 'rb') as f:
        data = f.read()
    reserved, typ, count = struct.unpack('<HHH', data[:6])
    if reserved != 0 or typ != 1:
        raise ValueError('不是合法 ICO：reserved=%d type=%d' % (reserved, typ))
    sizes = []
    for i in range(count):
        off = 6 + i * 16
        w, h = struct.unpack('<BB', data[off:off + 2])
        sizes.append(w or 256)
    return sizes
