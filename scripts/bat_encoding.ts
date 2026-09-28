/**
 * bat_encoding.ts -- guard + fixer for .bat/.cmd encoding hazards.
 *
 * WHY THIS EXISTS
 * ---------------
 * cmd.exe re-reads a batch file by BYTE OFFSET. With `chcp 65001` active, a
 * multi-byte character anywhere in the file desynchronises that offset, and cmd
 * then (a) executes fragments of comment lines and (b) SILENTLY SKIPS real
 * command lines. Note "silently": the script still finishes, still prints
 * "Done", still exits 0.
 *
 * 2026-09-29 incident -- start_cdp.bat, Chinese living only in REM comments (~1 KB):
 *   - Chinese comment fragments executed as bogus commands
 *     ("'ebdriver' is not recognized", "'EM' is not recognized" -- the tail of "REM")
 *   - BOTH branches of an if/else printed ("[OK] BOSS already running on 9223" AND
 *     "[OK] BOSS window ready on 9223" -- they are mutually exclusive, so only a
 *     desynced parser can emit both)
 *   - the four `call :launch_platform ...` lines were skipped entirely, so only
 *     BOSS came up on 9223 and ports 9224-9227 never opened. The user saw
 *     "[WARN] port 9224..9227 not ready" with no way to know the script ate them.
 * Eleven launchers in this repo were affected at once.
 *
 * A UTF-8 BOM is equally fatal: it is 3 extra bytes before `@echo off`, so the
 * offset is wrong from the very first line. Editors and file-writing tools add
 * BOMs "helpfully" -- that happened to all 11 of these files in this repo.
 *
 * Chinese that genuinely must reach the user should be carried the way
 * install_first_run.bat does it: `powershell -EncodedCommand <base64(UTF-16LE)>`,
 * which keeps the .bat itself pure ASCII.
 *
 * This module is the SINGLE source of truth for the rule; scripts/contract_tests.ts
 * imports it, so the gate and the fixer can never disagree about what "safe" means.
 *
 * USAGE
 *   npx tsx scripts/bat_encoding.ts check   # exit 1 on any violation (gate mode)
 *   npx tsx scripts/bat_encoding.ts fix     # strip BOM / normalise CRLF, then re-check
 *   npx tsx scripts/bat_encoding.ts check --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Vendored / build / runtime-profile dirs that must never be scanned. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-app', 'target', 'tarball',
  'chrome-cdp-profile', '.workbuddy', '_tools',
]);

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface BatInspection {
  file: string;
  bytes: number;
  bom: boolean;
  /** Count of non-ASCII bytes AFTER the BOM, so the BOM is reported once, on its own. */
  nonAscii: number;
  firstNonAsciiOffset: number;
  bareLf: number;
}

/** Enumerate every .bat/.cmd under `root`, skipping vendored/build/profile dirs. */
export function collectBatFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (/\.(bat|cmd)$/i.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** Inspect one batch file. */
export function inspectBatFile(file: string): BatInspection {
  const buf = fs.readFileSync(file);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let nonAscii = 0;
  let firstNonAsciiOffset = -1;
  for (let i = bom ? 3 : 0; i < buf.length; i++) {
    if (buf[i] > 127) {
      nonAscii++;
      if (firstNonAsciiOffset < 0) firstNonAsciiOffset = i;
    }
  }
  const latin = buf.toString('latin1');
  const lf = (latin.match(/\n/g) || []).length;
  const crlf = (latin.match(/\r\n/g) || []).length;
  return { file, bytes: buf.length, bom, nonAscii, firstNonAsciiOffset, bareLf: lf - crlf };
}

/** Human-readable location of the first non-ASCII byte, to make failures actionable. */
export function locateFirstNonAscii(file: string, bom: boolean): { line: number; col: number; text: string } | null {
  const buf = fs.readFileSync(file);
  for (let i = bom ? 3 : 0; i < buf.length; i++) {
    if (buf[i] > 127) {
      const before = buf.subarray(0, i).toString('latin1');
      const line = before.split('\n').length;
      const col = i - (before.lastIndexOf('\n') + 1) + 1;
      const lineText = buf.toString('utf8').split(/\r?\n/)[line - 1] ?? '';
      return { line, col, text: lineText.trim().slice(0, 90) };
    }
  }
  return null;
}

/** Strip BOM + normalise to CRLF. Returns true when the file changed. */
export function fixBatFile(file: string): boolean {
  const buf = fs.readFileSync(file);
  let out: Buffer = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    out = buf.subarray(3);
  }
  // CRLF: batch labels / goto are safest with it, and it is what these files had.
  const latin = out.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  out = Buffer.from(latin, 'latin1');
  if (!out.equals(buf)) {
    fs.writeFileSync(file, out);
    return true;
  }
  return false;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isDirect = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  const mode = process.argv[2] || 'check';
  const root = REPO_ROOT;
  const files = collectBatFiles(root);
  const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');

  if (mode === 'fix') {
    let changed = 0;
    for (const f of files) if (fixBatFile(f)) { changed++; console.log('  fixed  ' + rel(f)); }
    console.log(changed === 0 ? 'nothing to fix' : `fixed ${changed} file(s)`);
  }

  const results = files.map(inspectBatFile);
  const violations = results.filter((r) => r.bom || r.nonAscii > 0);

  if (mode === 'check' && process.argv.includes('--json')) {
    console.log(JSON.stringify({ total: files.length, violations: violations.length, results }, null, 2));
    process.exit(violations.length ? 1 : 0);
  }

  if (violations.length) {
    console.error(`bat_encoding: ${violations.length} of ${files.length} .bat/.cmd file(s) are unsafe for cmd.exe\n`);
    for (const v of violations) {
      console.error(`  ${rel(v.file)}`);
      if (v.bom) console.error('    - UTF-8 BOM at offset 0 (3 bytes before @echo off)');
      if (v.nonAscii > 0) {
        const loc = locateFirstNonAscii(v.file, v.bom);
        console.error(`    - ${v.nonAscii} non-ASCII byte(s), first at line ${loc?.line} col ${loc?.col}`);
        if (loc?.text) console.error(`      ${loc.text}`);
      }
      if (v.bareLf > 0) console.error(`    - ${v.bareLf} bare LF line ending(s)`);
    }
    console.error('\nWhy: cmd.exe re-reads .bat by byte offset; with chcp 65001 active a');
    console.error('multi-byte character desyncs that offset, so cmd executes comment');
    console.error('fragments AND silently skips real command lines (2026-09-29 incident');
    console.error('in start_cdp.bat). Keep launchers pure ASCII, no BOM.');
    console.error('Carry Chinese via `powershell -EncodedCommand <base64>` instead');
    console.error('(see install_first_run.bat). Run: npx tsx scripts/bat_encoding.ts fix');
    process.exit(1);
  }

  console.log(`bat_encoding: OK -- ${files.length} .bat/.cmd file(s), all pure ASCII, no BOM`);
}
