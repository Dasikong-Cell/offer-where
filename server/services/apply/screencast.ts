/**
 * 操作录屏（真·CDP screencast）——对标 CareerBoom.ai「每次投递生成操作录屏」。
 * ─────────────────────────────────────────────────────────────
 * 此前「录屏回溯」名不副实：只是**单张静态截图**（`tryScreenshot`）。这里换成真机制：
 * 驱动侧用 `Page.startScreencast` 接收**浏览器合成器在页面重绘时推来的帧流**
 * （点击/跳转/弹窗都被连续捕获），本服务负责落盘归档与可回看形态。
 *
 * 回看形态（渐进降级，都不额外依赖）：
 *   1. `play.html` —— 自包含的连续播放页（按录制帧率循环播放 JPEG 帧），浏览器里点开即「看录像」；
 *   2. `out.mp4`   —— 本机装了 ffmpeg 时额外合成真视频；没装则跳过（不报错）。
 *
 * 设计约束：录制**只读页面**、只发 Page 域命令，绝不注入脚本，不改变投递行为；
 * 任何一环失败都只影响「有没有录像」，绝不影响投递结果。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { execAction } from '../browser.js';
import { DATA_DIR } from './common.js';

export interface RecordingResult {
  ok: boolean;
  /** 归档目录（/data/... 形式，供前端直链） */
  dir?: string;
  frames?: number;
  seconds?: number;
  /** 真视频（仅装了 ffmpeg 时非空） */
  video?: string | null;
  /** 连续播放页（无 ffmpeg 时的回看方式） */
  player?: string | null;
  error?: string;
}

/** 开始录制（帧流由驱动侧的 screencastFrame 事件落盘） */
export async function startRecording(
  platform: string,
  opts: { dir?: string; quality?: number; maxFrames?: number; maxSeconds?: number } = {},
): Promise<{ ok: boolean; dir?: string; error?: string }> {
  try {
    const res: any = await execAction(platform, 'screencast-start', {
      dir: opts.dir,
      quality: opts.quality ?? 55,
      maxFrames: opts.maxFrames ?? 1200,
      maxSeconds: opts.maxSeconds ?? 300,
    });
    if (!res?.ok) return { ok: false, error: res?.error || '启动录屏失败' };
    return { ok: true, dir: res?.data?.dir };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 停止录制并归档（生成播放页 / 可选 mp4） */
export async function stopRecording(platform: string, opts: { makeVideo?: boolean } = {}): Promise<RecordingResult> {
  try {
    const res: any = await execAction(platform, 'screencast-stop', {});
    const d = (res && res.data) || {};
    if (!res?.ok || !d.dir) return { ok: false, error: (res && res.error) || '停止录屏失败' };

    const rel = String(d.dir).replace(/^\/data\//, '');
    const absDir = path.join(DATA_DIR, ...rel.split('/'));
    const names: string[] = Array.isArray(d.names) ? d.names : [];
    const frames = Number(d.frames) || names.length;
    const seconds = Number(d.seconds) || 0;

    let player: string | null = null;
    let video: string | null = null;
    if (frames > 0) {
      try { player = writePlayer(absDir, names, seconds); } catch { /* 播放页失败不影响帧留存 */ }
      if (opts.makeVideo !== false) { try { video = tryMakeVideo(absDir, seconds); } catch { /* 无 ffmpeg 就跳过 */ } }
    }
    return { ok: true, dir: `/data/${rel}`, frames, seconds, player, video };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 录制帧率（用于播放页与 mp4 合成），夹在 [2,20] 之间避免极端值 */
function fpsOf(count: number, seconds: number): number {
  if (count <= 1) return 2;
  const raw = seconds > 0 ? count / seconds : 4;
  return Math.max(2, Math.min(20, Math.round(raw)));
}

/** 生成自包含的连续播放页（无外链、无 eval，符合本项目 CSP） */
function writePlayer(absDir: string, names: string[], seconds: number): string {
  const fps = fpsOf(names.length, seconds);
  const list = JSON.stringify(names);
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>操作录屏回看</title>
<style>
 body{margin:0;background:#111;color:#eee;font:14px/1.6 system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px}
 img{max-width:100%;max-height:78vh;border-radius:8px;background:#000}
 .bar{display:flex;gap:12px;align-items:center}
 button{background:#222;color:#eee;border:1px solid #444;border-radius:6px;padding:6px 14px;cursor:pointer}
 input[type=range]{width:320px}
 .muted{color:#999;font-size:12px}
</style></head><body>
<div class="bar"><button id="pp">暂停</button><input id="seek" type="range" min="0" max="1" value="0" /></div>
<img id="v" alt="录制帧" />
<div class="muted"><span id="pos"></span> · 共 ${names.length} 帧 · 约 ${fps} fps · ${seconds}s（本机装 ffmpeg 可自动合成 mp4）</div>
<script>
const frames=${list};
const fps=${fps};
let i=0,playing=true;
const img=document.getElementById('v'),pp=document.getElementById('pp'),seek=document.getElementById('seek'),pos=document.getElementById('pos');
seek.max=Math.max(0,frames.length-1);
function draw(){ if(!frames.length) return; img.src=frames[i]; seek.value=i; pos.textContent='第 '+(i+1)+' / '+frames.length+' 帧'; }
pp.addEventListener('click',()=>{ playing=!playing; pp.textContent=playing?'暂停':'播放'; });
seek.addEventListener('input',()=>{ i=Number(seek.value)||0; draw(); });
draw();
setInterval(()=>{ if(!playing||frames.length<2) return; i=(i+1)%frames.length; draw(); }, Math.round(1000/fps));
</script></body></html>`;
  const p = path.join(absDir, 'play.html');
  fs.writeFileSync(p, html, 'utf-8');
  return p;
}

/** 有 ffmpeg 就合成 mp4，否则返回 null（不报错、不影响帧留存） */
function tryMakeVideo(absDir: string, seconds: number): string | null {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) return null;
  const names = fs.readdirSync(absDir).filter((n) => /^f\d+\.jpg$/.test(n)).sort();
  if (!names.length) return null;
  const fps = fpsOf(names.length, seconds);
  const out = path.join(absDir, 'out.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', 'f%04d.jpg',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    'out.mp4',
  ], { cwd: absDir, stdio: 'ignore', shell: false });
  if (r.error || r.status !== 0 || !fs.existsSync(out)) return null;
  return out;
}
