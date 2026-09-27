/* OfferWhere self-extracting installer stub.
 *
 * GENERATED FILE -- produced by _tools/gen_sfx.mjs. Do not hand-edit the escaped
 * strings; change the generator instead (it is not shipped, see make_sfx.ps1).
 *
 * ASCII-ONLY SOURCE, deliberately. Every Chinese UI string below is written as
 * \uXXXX escapes, so this file contains ZERO non-ASCII bytes and no build machine,
 * codepage or compiler flag can misread it. (Contrast with the .bat/.ps1 rule in this
 * repo: those are decoded by cmd.exe/PowerShell 5.1 with the ANSI codepage, which is
 * why they must stay ASCII too -- here the concern is the C compiler's input charset.)
 *
 * Layout of the produced OfferWhere-Setup.exe:
 *   [ this stub PE ][ payload .zip ][ footer: "OFWSFX01" + u64 offset + u64 length ]
 * The footer occupies the LAST 24 bytes, so the stub locates the payload by seeking
 * to EOF-24. A zip with a prepended stub is not directly readable by tar, so the
 * payload is first copied out to %%TEMP%% and extracted from there, then deleted.
 *
 * Flow (in order):
 *   0. read footer, sanity-check that offset/length lie inside the file
 *   1. if <dest>\dist-app\offer-where.exe already exists -> just launch it (idempotent)
 *   2. else ask the user, create <dest>, copy the payload out, extract with
 *      %%SystemRoot%%\System32\tar.exe (Windows 10 1803+), falling back to
 *      Expand-Archive if tar is missing or fails
 *   3. launch the native shell, which shows the first-run Install dialog itself --
 *      the install step keeps exactly one implementation (install_first_run.bat)
 *
 * No console window (-mwindows), no admin rights, no registry writes: everything is
 * per-user under %%LOCALAPPDATA%%. Return code 0 = installed/launched, 1 = failed.
 *
 * Unattended mode (added so the installer itself can be verified end to end without a
 * human clicking a MessageBox, and so it can be pushed out by a script):
 *   OfferWhere-Setup.exe --extract-only
 *     - shows no dialog at all; behaves as if the user pressed OK
 *     - skips BOTH ShellExecuteW launches (it installs, it does not start the app)
 *     - the exit code is the whole result: 0 = extracted, 1 = failed
 *   Optional environment variables, both ignored unless --extract-only is given:
 *     OFFERWHERE_SFX_DEST=<dir>   install somewhere other than %%LOCALAPPDATA%%\OfferWhere
 *     OFFERWHERE_SFX_LOG=<file>   append an ASCII step log saying which branch was taken
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>

#define FOOTER_SIZE 24
#define CHUNK (1 << 20)
#define PATHSZ (32768)

static const char FOOTER_MAGIC[8] = {'O','F','W','S','F','X','0','1'};

/* dialog title: OfferWhere installer */
static const wchar_t *TITLE = L"OfferWhere \u5b89\u88c5\u7a0b\u5e8f";

/* --extract-only: never block on a dialog, never launch anything. */
static int SILENT = 0;

/* OFFERWHERE_SFX_LOG: append-only ASCII step log. An unattended run leaves behind
 * WHICH branch it took -- without it, a failed silent run is indistinguishable from
 * a silent run that did nothing, because there is no window to read. */
static wchar_t LOGPATH[PATHSZ];

static void logline(const wchar_t *fmt, ...) {
  FILE *f;
  va_list ap;
  wchar_t wbuf[2048];
  char nbuf[8192];
  if (!SILENT || !LOGPATH[0]) return;
  va_start(ap, fmt);
  _vsnwprintf(wbuf, 2047, fmt, ap);
  va_end(ap);
  wbuf[2047] = 0;
  /* Written as UTF-8 BYTES, not as wide characters. _wfopen + fwprintf produces UTF-16LE
   * with NO BOM, which every reader then shows as interleaved NULs -- the author's own log
   * reader did exactly that on the first run. The lines are ASCII, so writing bytes changes
   * nothing about the content and makes the file readable everywhere. */
  if (WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, nbuf, (int)sizeof(nbuf), NULL, NULL) <= 0) return;
  f = _wfopen(LOGPATH, L"ab");
  if (!f) return;
  fprintf(f, "%s\r\n", nbuf);
  fclose(f);
}

/* flags first, then the format: the varargs must directly follow the format string,
 * otherwise the compiler reads the first %ls argument as the flags. */
static int msgbox(UINT flags, const wchar_t *fmt, ...) {
  wchar_t buf[8192];
  va_list ap;
  if (SILENT) return IDOK; /* unattended: no dialog, as if the user pressed OK */
  va_start(ap, fmt);
  _vsnwprintf(buf, 8191, fmt, ap);
  va_end(ap);
  buf[8191] = 0;
  return MessageBoxW(NULL, buf, TITLE, flags);
}

/* Recursively create a directory; SHCreateDirectoryExW handles nested paths. */
static int ensure_dir(const wchar_t *dir) {
  int rc = SHCreateDirectoryExW(NULL, dir, NULL);
  return rc == ERROR_SUCCESS || rc == ERROR_FILE_EXISTS || rc == ERROR_ALREADY_EXISTS;
}

static int file_exists(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static int read_footer(const wchar_t *exe, unsigned long long *off, unsigned long long *len) {
  FILE *f = _wfopen(exe, L"rb");
  char buf[FOOTER_SIZE];
  if (!f) return 0;
  if (_fseeki64(f, -(long long)FOOTER_SIZE, SEEK_END) != 0) { fclose(f); return 0; }
  if (fread(buf, 1, FOOTER_SIZE, f) != FOOTER_SIZE) { fclose(f); return 0; }
  fclose(f);
  if (memcmp(buf, FOOTER_MAGIC, 8) != 0) return 0;
  memcpy(off, buf + 8, 8);
  memcpy(len, buf + 16, 8);
  return 1;
}

static int file_size(const wchar_t *p, unsigned long long *out) {
  HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  LARGE_INTEGER sz;
  if (h == INVALID_HANDLE_VALUE) return 0;
  if (!GetFileSizeEx(h, &sz)) { CloseHandle(h); return 0; }
  CloseHandle(h);
  *out = (unsigned long long)sz.QuadPart;
  return 1;
}

/* Copy [off, off+len) of the setup exe into dst. */
static int copy_payload(const wchar_t *exe, unsigned long long off, unsigned long long len, const wchar_t *dst) {
  FILE *in = _wfopen(exe, L"rb");
  FILE *out = NULL;
  char *buf = NULL;
  unsigned long long left = len;
  int ok = 0;
  if (!in) return 0;
  if (_fseeki64(in, (long long)off, SEEK_SET) != 0) goto done;
  out = _wfopen(dst, L"wb");
  if (!out) goto done;
  buf = (char *)malloc(CHUNK);
  if (!buf) goto done;
  while (left > 0) {
    size_t want = (size_t)(left < CHUNK ? left : CHUNK);
    size_t got = fread(buf, 1, want, in);
    if (got != want) goto done;
    if (fwrite(buf, 1, got, out) != got) goto done;
    left -= got;
  }
  ok = 1;
done:
  if (buf) free(buf);
  if (out) fclose(out);
  fclose(in);
  return ok;
}

/* Run a command line with no visible window; returns the exit code, or -1 if the
 * process could not be started at all. */
static int run_hidden(const wchar_t *cmdline) {
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  DWORD code = (DWORD)-1;
  wchar_t *mutable_cmd = _wcsdup(cmdline);
  if (!mutable_cmd) return -1;
  memset(&si, 0, sizeof(si));
  si.cb = sizeof(si);
  memset(&pi, 0, sizeof(pi));
  if (CreateProcessW(NULL, mutable_cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
  free(mutable_cmd);
  return (int)code;
}

static void append(wchar_t *dst, size_t cap, const wchar_t *suffix) {
  size_t have = wcslen(dst);
  if (have < cap - 1) wcsncat(dst, suffix, cap - have - 1);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdline, int show) {
  wchar_t self[PATHSZ];
  wchar_t root[PATHSZ];
  wchar_t exePath[PATHSZ];
  wchar_t tmpDir[PATHSZ];
  wchar_t tmpZip[PATHSZ];
  wchar_t sysRoot[MAX_PATH];
  wchar_t cmd[PATHSZ];
  unsigned long long off = 0, len = 0, total = 0;
  int exitCode;

  (void)hInst; (void)hPrev; (void)show;

  if (cmdline && (wcsstr(cmdline, L"--extract-only") || wcsstr(cmdline, L"--silent"))) SILENT = 1;
  if (!GetEnvironmentVariableW(L"OFFERWHERE_SFX_LOG", LOGPATH, PATHSZ)) LOGPATH[0] = 0;
  logline(L"[0] start (silent=%d)", SILENT);

  if (!GetModuleFileNameW(NULL, self, PATHSZ)) {
    msgbox(MB_OK | MB_ICONERROR, L"cannot locate the installer path");
    return 1;
  }
  if (!read_footer(self, &off, &len)) {
    logline(L"[0] FAIL footer missing (not a complete setup exe?)");
    msgbox(MB_OK | MB_ICONERROR, L"\u8fd9\u4e2a\u6587\u4ef6\u4e0d\u662f\u5b8c\u6574\u7684\u5b89\u88c5\u7a0b\u5e8f\uff08\u5c3e\u90e8\u6807\u8bb0\u7f3a\u5931\uff09\uff0c\u591a\u534a\u662f\u4e0b\u8f7d\u4e2d\u65ad\u3002\n\n\u8bf7\u91cd\u65b0\u4e0b\u8f7d OfferWhere-Setup.exe \u540e\u518d\u8fd0\u884c\u3002");
    return 1;
  }
  if (!file_size(self, &total) || off == 0 || len == 0 || off + len > total) {
    logline(L"[0] FAIL footer out of range");
    msgbox(MB_OK | MB_ICONERROR, L"\u5b89\u88c5\u7a0b\u5e8f\u5185\u90e8\u6570\u636e\u8d8a\u754c\uff08offset/length \u4e0d\u5408\u7406\uff09\uff0c\u6587\u4ef6\u53ef\u80fd\u5df2\u635f\u574f\u3002\n\n\u8bf7\u91cd\u65b0\u4e0b\u8f7d\u3002");
    return 1;
  }

  /* dest = %LOCALAPPDATA%\OfferWhere, or OFFERWHERE_SFX_DEST when set (unattended) */
  {
    DWORD got = GetEnvironmentVariableW(L"OFFERWHERE_SFX_DEST", root, PATHSZ);
    if (got > 0 && got < PATHSZ) {
      logline(L"[1] dest from OFFERWHERE_SFX_DEST");
    } else if (GetEnvironmentVariableW(L"LOCALAPPDATA", root, PATHSZ)) {
      append(root, PATHSZ, L"\\OfferWhere");
    } else {
      logline(L"[1] FAIL no LOCALAPPDATA and no OFFERWHERE_SFX_DEST");
      msgbox(MB_OK | MB_ICONERROR, L"\u65e0\u6cd5\u521b\u5efa\u5b89\u88c5\u76ee\u5f55\uff1a\n%ls\n\n\u8bf7\u786e\u8ba4\u78c1\u76d8\u7a7a\u95f4\u5145\u8db3\uff08\u7ea6\u9700 1.2GB \u53ef\u7528\uff09\uff0c\u6216\u6362\u4e00\u4e2a\u78c1\u76d8\u540e\u91cd\u8bd5\u3002", L"%LOCALAPPDATA%");
      return 1;
    }
  }
  _snwprintf(exePath, PATHSZ, L"%ls\\dist-app\\offer-where.exe", root);
  logline(L"[1] dest=%ls", root);

  /* already installed: launch, do not re-extract (30s of I/O for nothing) */
  if (file_exists(exePath)) {
    logline(L"[2] already installed, nothing to do");
    msgbox(MB_OK | MB_ICONINFORMATION, L"\u5df2\u5728\u4e0b\u9762\u8fd9\u4e2a\u4f4d\u7f6e\u68c0\u6d4b\u5230 OfferWhere\uff0c\u76f4\u63a5\u542f\u52a8\uff1a\n\n%ls\n\n\uff08\u8981\u91cd\u65b0\u89e3\u538b\u5b89\u88c5\uff0c\u8bf7\u5148\u5220\u6389\u8be5\u6587\u4ef6\u5939\u518d\u8fd0\u884c\u672c\u5b89\u88c5\u7a0b\u5e8f\u3002\uff09", root);
    if (SILENT) return 0; /* unattended runs install; they must not start the app */
    if ((INT_PTR)ShellExecuteW(NULL, L"open", exePath, NULL, root, SW_SHOWNORMAL) <= 32) {
      msgbox(MB_OK | MB_ICONERROR, L"\u89e3\u538b\u5df2\u5b8c\u6210\uff0c\u4f46\u542f\u52a8\u5916\u58f3\u5931\u8d25\uff1a\n%ls\n\n\u8bf7\u624b\u52a8\u53cc\u51fb\u6253\u5f00\u8be5\u6587\u4ef6\u3002", exePath);
      return 1;
    }
    return 0;
  }

  if (msgbox(MB_OKCANCEL | MB_ICONINFORMATION, L"\u5373\u5c06\u5b89\u88c5 OfferWhere \u6295\u9012\u52a9\u624b\u3002\n\n\u5b89\u88c5\u4f4d\u7f6e\uff1a\n%ls\n\n\u7ea6 12.5 \u4e07\u4e2a\u6587\u4ef6\u3001\u5360 1.2GB \u5de6\u53f3\uff0c\u89e3\u538b\u9700\u8981\u4e00\u5230\u4e09\u5206\u949f\u3002\n\u671f\u95f4\u4e0d\u4f1a\u6709\u8fdb\u5ea6\u63d0\u793a\uff0c\u8bf7\u52ff\u5173\u95ed\u7a97\u53e3\u3001\u52ff\u91cd\u590d\u53cc\u51fb\u3002\n\n\u70b9\u300c\u786e\u5b9a\u300d\u5f00\u59cb\u5b89\u88c5\u3002", root) != IDOK) {
    logline(L"[4] cancelled");
    return 0;
  }
  logline(L"[4] confirmed, extracting");

  if (!ensure_dir(root)) {
    logline(L"[5] FAIL cannot create dest dir");
    msgbox(MB_OK | MB_ICONERROR, L"\u65e0\u6cd5\u521b\u5efa\u5b89\u88c5\u76ee\u5f55\uff1a\n%ls\n\n\u8bf7\u786e\u8ba4\u78c1\u76d8\u7a7a\u95f4\u5145\u8db3\uff08\u7ea6\u9700 1.2GB \u53ef\u7528\uff09\uff0c\u6216\u6362\u4e00\u4e2a\u78c1\u76d8\u540e\u91cd\u8bd5\u3002", root);
    return 1;
  }
  logline(L"[5] dest dir ready");

  if (!GetTempPathW(PATHSZ, tmpDir)) { wcsncpy(tmpDir, L".\\", PATHSZ - 1); tmpDir[PATHSZ - 1] = 0; }
  _snwprintf(tmpZip, PATHSZ, L"%lsofferwhere-payload-%lu.zip", tmpDir, GetCurrentProcessId());

  if (!copy_payload(self, off, len, tmpZip)) {
    logline(L"[6] FAIL payload copy");
    msgbox(MB_OK | MB_ICONERROR, L"\u65e0\u6cd5\u4ece\u5b89\u88c5\u7a0b\u5e8f\u4e2d\u53d6\u51fa\u6570\u636e\uff08\u76ee\u6807\uff1a%ls\uff09\u3002\n\n\u8bf7\u786e\u8ba4\u78c1\u76d8\u7a7a\u95f4\u5145\u8db3\uff08\u7ea6\u9700 1.2GB \u53ef\u7528\uff09\u3002", tmpZip);
    return 1;
  }
  logline(L"[6] payload copied, extracting with tar.exe");

  if (!GetEnvironmentVariableW(L"SystemRoot", sysRoot, MAX_PATH)) wcsncpy(sysRoot, L"C:\\Windows", MAX_PATH - 1);
  _snwprintf(cmd, PATHSZ, L"\"%ls\\System32\\tar.exe\" -xf \"%ls\" -C \"%ls\"", sysRoot, tmpZip, root);
  exitCode = run_hidden(cmd);
  logline(L"[7] tar.exe rc=%d", exitCode);

  if (exitCode != 0) {
    /* fallback: Expand-Archive (slower, but present on every Windows with PowerShell) */
    _snwprintf(cmd, PATHSZ,
      L"powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Expand-Archive -LiteralPath '%ls' -DestinationPath '%ls' -Force\"",
      tmpZip, root);
    exitCode = run_hidden(cmd);
    logline(L"[7] Expand-Archive rc=%d", exitCode);
  }

  DeleteFileW(tmpZip);

  if (!file_exists(exePath)) {
    logline(L"[8] FAIL extraction produced no shell (rc=%d)", exitCode);
    msgbox(MB_OK | MB_ICONERROR, L"\u89e3\u538b\u5931\u8d25\uff1a\u7cfb\u7edf\u81ea\u5e26\u7684 tar \u4e0e Expand-Archive \u90fd\u6ca1\u6210\u529f\u3002\n\n\u8bf7\u786e\u8ba4\u78c1\u76d8\u7a7a\u95f4\u5145\u8db3\uff08\u7ea6\u9700 1.2GB \u53ef\u7528\uff09\uff0c\u6216\u628a\u672c\u6587\u4ef6\u79fb\u52a8\u5230\u522b\u7684\u78c1\u76d8\u540e\u91cd\u8bd5\u3002\n\n\u6700\u8fd1\u4e00\u6b21\u9519\u8bef\u7801\uff1a%d", exitCode);
    return 1;
  }

  logline(L"[8] ok, shell present");
  msgbox(MB_OK | MB_ICONINFORMATION, L"\u89e3\u538b\u5b8c\u6210\uff0c\u6b63\u5728\u542f\u52a8 OfferWhere\u2026\n\n\u7b2c\u4e00\u6b21\u542f\u52a8\u4f1a\u5f39\u51fa\u300c\u5b89\u88c5\u300d\u5bf9\u8bdd\u6846\uff1a\u70b9\u4e00\u4e0b\u300c\u5b89\u88c5\u300d\uff0c\u684c\u9762\u5c31\u4f1a\u51fa\u73b0 OfferWhere \u56fe\u6807\uff0c\u4ee5\u540e\u53cc\u51fb\u8be5\u56fe\u6807\u5373\u53ef\u4f7f\u7528\u3002");
  if (SILENT) return 0; /* unattended runs install; they must not start the app */
  if ((INT_PTR)ShellExecuteW(NULL, L"open", exePath, NULL, root, SW_SHOWNORMAL) <= 32) {
    msgbox(MB_OK | MB_ICONERROR, L"\u89e3\u538b\u5df2\u5b8c\u6210\uff0c\u4f46\u542f\u52a8\u5916\u58f3\u5931\u8d25\uff1a\n%ls\n\n\u8bf7\u624b\u52a8\u53cc\u51fb\u6253\u5f00\u8be5\u6587\u4ef6\u3002", exePath);
    return 1;
  }
  return 0;
}
