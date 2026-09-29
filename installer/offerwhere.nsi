; ===========================================================================
; OfferWhere -- NSIS installer
;
; WHY THIS FILE EXISTS
;   The self-extracting exe (tools/sfx + make_sfx.ps1) already collapses the
;   download to "one file, double-click". What it cannot provide is the part
;   every user expects from an installer: a choosable directory, a Start Menu
;   entry, and a working "Apps & features" uninstall. This script is that.
;   It replaced the SFX as the published installer on 2026-09-28.
;
; ARCHITECTURE (deliberate -- see skill offer-where-pack-and-release s15)
;   The payload is the SAME job-apply-agent-portable.zip the SFX embeds, stored
;   UNCOMPRESSED (SetCompress off) because it is already a zip: compressing it
;   again buys ~0% and costs minutes. Measured: embedding 362 MB this way takes
;   3 s and adds ~59 KB over the raw zip.
;   Unpacking is delegated to the system bsdtar at %SystemRoot%\System32\tar.exe
;   (present on Windows 10 1803+, the same floor WebView2 already imposes). The
;   zip must exist as a real file first -- tar cannot read a zip that has an
;   installer stub prepended -- so $PLUGINSDIR (temp, auto-deleted on exit) is
;   the staging area, and the copy is deleted as soon as tar returns: 362 MB
;   should not sit in %TEMP% while 1.3 GB is being written next to it.
;
; PURE ASCII, ON PURPOSE
;   Everything here is ASCII; the Chinese installer UI comes from NSIS's own
;   Contrib "SimpChinese" language files via MUI_LANGUAGE, not from this file.
;   That keeps the encoding question out of a script CI compiles on a machine
;   whose code page may differ from the author's -- the same class of bug that
;   bit the .ps1 evidence scripts (see the pack skill s14.8).
;
; BUILD
;   Do not call makensis directly; use ./make_nsis.ps1, which injects the
;   defines below and checks the output. Invoked bare, this script fails loudly
;   instead of quietly producing an installer with no payload.
; ===========================================================================

Unicode true
SetCompressor /FINAL zlib

!include "MUI2.nsh"
!include "LogicLib.nsh"
; ${GetOptions}: parses our own /NODESKTOP switch out of $CMDLINE (see .onInit).
!include "FileFunc.nsh"

; ---------------------------------------------------------------- injected
!ifndef PAYLOAD_ZIP
  !error "PAYLOAD_ZIP is not defined. Build with ./make_nsis.ps1, not makensis directly."
!endif
!ifndef OUTFILE
  !error "OUTFILE is not defined. Build with ./make_nsis.ps1, not makensis directly."
!endif
!ifndef APPVER
  !define APPVER "0.0.0"
!endif
!ifndef PRODUCTVER
  !define PRODUCTVER "0.0.0.0"
!endif

; Overridable so a test build can point the extractor at a file that does not
; exist -- the only way to reach the missing-tar branch on a machine that has
; tar.exe. An unreachable error path is an untested error path; this repo has
; already paid for that lesson once ("asserts-implemented != asserts-reachable").
!ifndef TAR_EXE
  !define TAR_EXE "$SYSDIR\tar.exe"
!endif

; ---------------------------------------------------------------- icon
; The one file a user sees BEFORE the app is the setup exe -- in the download bar, in
; Explorer, and in the SmartScreen prompt. Without this it carried NSIS's own default
; icon, i.e. the product's first impression was somebody else's logo. (Found 2026-09-28 by
; running an "icon appears in ALL locations" release checklist against this installer:
; exe / window / tray / favicon / in-app were all covered, the NSIS wizard was not.)
; Default path is derived from THIS file, not from the caller's working directory, so a
; build from any cwd works. Overridable for a build that ships a different brand mark.
; public\app.ico is the single source of truth for the icon (see skill s15 / MEMORY):
; it is a real 6-layer ICO (16/32/48/64/128/256 @32bpp), which is what MUI requires.
!ifndef ICON_FILE
  !define ICON_FILE "${__FILEDIR__}\..\public\app.ico"
!endif

; ---------------------------------------------------------------- constants
!define APPNAME    "OfferWhere"
!define APP_KEY    "Software\OfferWhere"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OfferWhere"
!define ENTRY_EXE  "dist-app\offer-where.exe"
!define ENTRY_BAT  "start_all.bat"
!define ICON_REL   "public\app.ico"
; Space accounting on the directory page. Two different numbers, and mixing them up is
; visible to the user as a wrong "space required":
;   INSTALLED_KB  what the expanded tree occupies (~1.11 GiB measured) -> EstimatedSize
;                 in "Apps & features".
;   PAGE_KB       what AddSize should add. NSIS already counts the size of every file the
;                 installer writes with File, and that file is the staged payload.zip
;                 (~370 MB, uncompressed by SetCompress off). So AddSize must add only the
;                 DELTA: 1140800 - 370700 = 770100. Passing the full installed size here
;                 double-counts the payload -- the page claimed 1.7 GB for a 1.1 GB install
;                 until 2026-09-28, which is enough to talk a user out of a machine that
;                 had plenty of room. Re-derive the delta from the measured numbers in the
;                 pack skill s15.8 if the payload grows.
!define INSTALLED_KB 1140800
!define PAGE_KB      770100

; Two entry points now write a shortcut (Start Menu, and optionally Desktop), so
; the target resolution is a macro rather than a copy: judging the package ROOT
; for offer-where.exe is the defect that shipped once (it never exists there),
; and two hand-maintained copies of this is how it ships twice.
!macro ResolveEntry outvar
  StrCpy ${outvar} "$INSTDIR\${ENTRY_BAT}"
  IfFileExists "$INSTDIR\${ENTRY_EXE}" 0 +2
    StrCpy ${outvar} "$INSTDIR\${ENTRY_EXE}"
!macroend

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\OfferWhere"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
; Per-user install: no UAC prompt, no admin, and the uninstall entry lands in
; HKCU so removing it needs no elevation either. Same contract as the SFX.
RequestExecutionLevel user
; Icon = the setup exe's own icon; UninstallIcon = the uninstaller's. MUI_ICON/MUI_UNICON
; (defined with the pages below) are what the wizard's title bar and the Uninstall.exe use.
; All four point at the same file so there is exactly one brand mark in the product.
; The base-installer directive is `UninstallIcon`, NOT `UnIcon` -- `UnIcon` does not exist and
; the compiler says only `Invalid command: "UnIcon"`, which reads like a typo rather than a
; wrong name. (MUI_UNICON is what actually feeds it: Contrib/Modern UI 2/Interface.nsh.)
Icon          "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"
BrandingText "${APPNAME} ${APPVER}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${PRODUCTVER}"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion" "${APPVER}"
; Not decoration: makensis warns 9100 about a missing standard key, and a warning-clean
; build means a future `makensis /WX` in CI cannot be defeated by noise.
VIAddVersionKey "LegalCopyright" "See LICENSE in the installed package"

; ---------------------------------------------------------------- UI
; MUI_ICON / MUI_UNICON must be defined BEFORE the page macros below.
!define MUI_ICON   "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
; The directory page is the point of the exercise: the installer must NOT
; decide where the product lives (explicit user requirement, 2026-09-28).
; MUI_FINISHPAGE_RUN_TEXT is deliberately undefined -- the SimpChinese language
; file already supplies a localised label, and defining it here would drag
; non-ASCII bytes into this file.
!define MUI_FINISHPAGE_RUN "$INSTDIR\${ENTRY_EXE}"

!insertmacro MUI_PAGE_WELCOME
; The components page carries exactly ONE optional item: the desktop shortcut.
; It exists because the shortcut lands OUTSIDE the install dir (someone else's
; desktop), so it is the one thing the installer should not decide unilaterally
; -- the same reason the directory page exists. Default ON: that is what every
; build before 2026-09-29 did, so nobody silently loses a shortcut they expect.
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; Our own UI text (component names + their descriptions) cannot be written here:
; this file is held to pure ASCII so the build never depends on the compiler
; machine's code page. It lives in ui_strings.nsh, UTF-8 **with a BOM** -- see
; the header of that file for why the BOM is load-bearing. It must be included
; AFTER MUI_LANGUAGE: LangString resolves ${LANG_SIMPCHINESE}, which only
; exists once the language file has been loaded.
!include "${__FILEDIR__}\ui_strings.nsh"

Var TarRC
Var TarOut
Var KeepData
; Uninstall-side enumeration (see the "keep data" branch). Declared at file scope
; because NSIS has no block-scoped variables.
Var Fh
Var Fn

; ===========================================================================
; Install
; ===========================================================================
Section "$(STR_SEC_CORE)" SEC_MAIN
  SectionIn RO
  SetShellVarContext current
  AddSize ${PAGE_KB}

  ; Unusable without an extractor, and there is no point unpacking 125000 files
  ; before saying so. Windows 10 1803+ always has tar.exe.
  IfFileExists "${TAR_EXE}" have_tar
    MessageBox MB_ICONSTOP "This installer needs the Windows built-in extractor, but it is missing:$\r$\n${TAR_EXE}$\r$\n$\r$\nThat means this Windows is older than version 1803 (April 2018), which ${APPNAME} cannot run on anyway.$\r$\n$\r$\nPlease use job-apply-agent-portable.zip instead, or a newer Windows."
    Abort
  have_tar:

  ; ---------------------------------------------------------------- payload
  InitPluginsDir
  SetCompress off
  File /oname=$PLUGINSDIR\payload.zip "${PAYLOAD_ZIP}"

  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"

  DetailPrint "Unpacking ${APPNAME} (about 125000 files, this takes 1-3 minutes) ..."
  StrCpy $TarRC "-1"
  StrCpy $TarOut ""
  nsExec::ExecToStack '"${TAR_EXE}" -xf "$PLUGINSDIR\payload.zip" -C "$INSTDIR"'
  Pop $TarRC
  Pop $TarOut

  ; Hand the 362 MB back now rather than at process exit.
  Delete "$PLUGINSDIR\payload.zip"

  StrCmp $TarRC "0" unpack_ok
    DetailPrint "extractor returned $TarRC"
    DetailPrint "$TarOut"
    RMDir /r "$INSTDIR"
    MessageBox MB_ICONSTOP "Could not unpack ${APPNAME} into:$\r$\n$INSTDIR$\r$\n$\r$\nThe extractor reported error $TarRC and the folder has been removed.$\r$\n$\r$\nIf this keeps happening, download job-apply-agent-portable.zip instead and extract it with tar or 7-Zip."
    Abort
  unpack_ok:

  ; Fail closed: an installer that "succeeds" without the entry point is worse
  ; than one that fails, because the shortcut it just wrote would dangle.
  IfFileExists "$INSTDIR\${ENTRY_BAT}" entry_ok
    RMDir /r "$INSTDIR"
    MessageBox MB_ICONSTOP "The package unpacked but does not contain ${ENTRY_BAT}, so it cannot be started.$\r$\n$\r$\nThe folder has been removed. Please report this build: the payload zip is incomplete."
    Abort
  entry_ok:

  ; ---------------------------------------------------------------- entry points
  ; Target resolution mirrors create_desktop_shortcut.bat exactly: prefer the
  ; native shell, fall back to start_all.bat. Judging the package ROOT for
  ; offer-where.exe is the mistake that shipped once (it never exists there),
  ; so this only ever looks inside dist-app\.
  !insertmacro ResolveEntry $0

  ; Start Menu entry: always. It lives under %APPDATA%, i.e. inside the user's
  ; own profile, so unlike the desktop it is not somebody else's real estate --
  ; and it is what "Apps & features" and every launcher index expect to find.
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  IfFileExists "$INSTDIR\${ICON_REL}" 0 shortcut_noicon
    CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$0" "" "$INSTDIR\${ICON_REL}" 0 "" "" "offer-where console"
    Goto shortcuts_done
  shortcut_noicon:
    CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$0" "" "" 0 "" "" "offer-where console"
  shortcuts_done:

  ; ---------------------------------------------------------------- first run
  ; Suppress the app's own first-run "Install" prompt.
  ; install_first_run.bat exists because the SFX only ever unpacked files -- it never
  ; touched the shell -- so the first launch had to offer to create an entry point.
  ; This installer already created the Start Menu entry (and the Desktop one when
  ; the user left that component ticked -- since 2026-09-29 it is optional, see
  ; SEC_DESKTOP below) plus the uninstall entry. Left alone, the first launch would
  ; ask the user to press "Install" a second time for work that is already done.
  ; The prompt has exactly two effects -- run create_desktop_shortcut.bat /silent,
  ; then write this marker (install_first_run.bat's decoded payload; the guard is
  ; src-tauri/src/lib.rs). The shortcut half is what we just replaced, and the marker
  ; is the SAME file start_all.bat and lib.rs already agree on: a third writer of an
  ; existing convention, not a second convention.
  CreateDirectory "$INSTDIR\data"
  FileOpen $1 "$INSTDIR\data\.installed" w
  FileClose $1

  ; ---------------------------------------------------------------- uninstall
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKCU "${APP_KEY}"    "InstallDir" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion" "${APPVER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${ICON_REL}"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" ${INSTALLED_KB}
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; ---------------------------------------------------------------- desktop shortcut
; The ONE optional component. It is optional because the desktop is the user's
; space, not ours -- but it stays ON by default so nobody who upgrades loses the
; icon they already have. Unchecking it changes nothing else: the Start Menu
; entry, the uninstall entry and the app itself are all unaffected.
; Note this runs AFTER SEC_MAIN, so $INSTDIR is already populated and the entry
; point can be resolved the same way (same macro -- one rule, two callers).
Section "$(STR_SEC_DESKTOP)" SEC_DESKTOP
  SetShellVarContext current
  !insertmacro ResolveEntry $1
  IfFileExists "$INSTDIR\${ICON_REL}" 0 desktop_noicon
    CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$1" "" "$INSTDIR\${ICON_REL}" 0 "" "" "offer-where console"
    Goto desktop_done
  desktop_noicon:
    CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$1" "" "" 0 "" "" "offer-where console"
  desktop_done:
SectionEnd

; Component descriptions. Without this block the components page still works,
; but its bottom pane stays blank and the checkbox is unexplained -- and an
; unexplained checkbox that is ON by default is the kind of thing people notice
; only after it has already put an icon on their desktop.
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN}    "$(STR_SEC_CORE_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "$(STR_SEC_DESKTOP_DESC)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ===========================================================================
; .onInit
; ===========================================================================
; DEFINED HERE, AFTER THE SECTIONS, ON PURPOSE: a Section's index constant
; (${SEC_DESKTOP}) only exists from the moment that Section is parsed. Written
; above them, makensis says `unknown variable/constant "{SEC_DESKTOP}"` and then
; `Usage: SectionSetFlags section_index flags` -- the second line reads like the
; flag value is wrong, but the real problem is the missing constant. Placement
; is the fix, not the argument. (Measured 2026-09-29, NSIS 3.11.)
Function .onInit
  ; /NODESKTOP is the silent-install twin of the components-page checkbox: a
  ; scripted deployment cannot tick or untick anything, so without a switch the
  ; one optional component is unreachable there and every /S install gets a
  ; desktop icon whether it wants one or not. Both paths clear the same flag.
  ; NOTE: /D= swallows the rest of the command line, so /NODESKTOP must come
  ; BEFORE it:  OfferWhere-Setup.exe /S /NODESKTOP /D=D:\OfferWhere
  ${GetOptions} $CMDLINE "/NODESKTOP" $R0
  IfErrors nodt_done 0
    SectionSetFlags ${SEC_DESKTOP} 0
  nodt_done:
FunctionEnd

; ===========================================================================
; .onInit
; ===========================================================================
; DEFINED HERE, AFTER THE SECTIONS, ON PURPOSE: a Section's index constant
; (${SEC_DESKTOP}) only exists from the moment that Section is parsed. Written
; above them, makensis says `unknown variable/constant "{SEC_DESKTOP}"` and then
; `Usage: SectionSetFlags section_index flags` -- the second line reads like the
; flag value is wrong, but the real problem is the missing constant. Placement
; is the fix, not the argument.

; ===========================================================================
; Uninstall
; ===========================================================================
Function un.onInit
  ; Default is KEEP. Pressing Enter at a destructive prompt must not be the
  ; thing that deletes somebody's resume and apply history.
  StrCpy $KeepData "1"

  ; An unattended uninstall must not sit on a dialog nobody can see.
  ; Measured (u3.nsi, 2026-09-28, 6 variants, 120 s observation window, same tree):
  ;   box + IfSilent   -> the uninstaller returns in 0.1 s and the tree is gone 0.5 s later
  ;   box, no IfSilent -> returns in 7.3 s and the tree takes 22.0 s to settle
  ; The deletion still happens either way -- this is a stall, not a failure. (An earlier
  ; note here claimed the box turned the whole uninstaller into a no-op; a long-window
  ; re-run refuted that. Keep the claim out.)
  ; IfSilent costs nothing when a human IS watching: the box still appears normally.
  IfSilent un_ask_done

  ; /SD must sit AFTER the message text (putting it in the mode flags is a
  ; compile error: "Usage: MessageBox"), and the return-check MUST sit on the
  ; same line as the text -- NSIS ends an instruction at the newline, so a
  ; trailing "IDNO label" on its own line is parsed as a command and the build
  ; dies with `Invalid command: "IDNO"`.
  MessageBox MB_YESNO|MB_DEFBUTTON2 "Delete your local data as well?$\r$\n$\r$\n$INSTDIR\data holds your resume, the job descriptions you collected and your apply history. It is KEPT unless you pick Yes." /SD IDNO IDNO un_ask_done
    StrCpy $KeepData "0"
  un_ask_done:
FunctionEnd

Section "Uninstall"
  SetShellVarContext current

  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"

  ; Plain StrCmp+Goto rather than LogicLib here: a Goto that leaves an ${If}
  ; block without its ${EndIf} leaves LogicLib's own stack dirty.
  StrCmp $KeepData "1" 0 un_wipe

  IfFileExists "$INSTDIR\data" 0 un_wipe
    ; "Keep my data" has to survive the user choosing another drive, and the
    ; obvious implementation does not. The obvious one is Rename the subtree out
    ; of the way, delete the rest, Rename it back. Rename cannot cross volumes:
    ; with $INSTDIR on D: and $LOCALAPPDATA on C: it fails, IfErrors sends us to
    ; un_wipe, and the branch that exists to PRESERVE the user's resume silently
    ; deletes it instead. Verified with a two-mode probe (u2.nsi): MODE=1
    ; (Rename) -> "data KEPT=False" when installed to another drive; MODE=2 ->
    ; KEPT=True on both the same volume and a different one.
    ; So: enumerate $INSTDIR and delete every top-level entry except data\.
    ; data\ is where it always was, nothing is moved, and the volume layout
    ; stops mattering. This also removes the temporary "OfferWhere-data" folder
    ; that a cross-volume Rename would have left behind.
    FindFirst $Fh $Fn "$INSTDIR\*.*"
    un_keep_loop:
      StrCmp $Fn "" un_keep_done
      StrCmp $Fn "."  un_keep_next
      StrCmp $Fn ".." un_keep_next
      StrCmp $Fn "data" un_keep_next
      ; IfFileExists with a wildcard is the only way to ask "is this a folder?"
      ; without pulling in a FileFunc header.
      IfFileExists "$INSTDIR\$Fn\*.*" 0 un_keep_file
        RMDir /r "$INSTDIR\$Fn"
        Goto un_keep_next
      un_keep_file:
      Delete "$INSTDIR\$Fn"
      Goto un_keep_next
    un_keep_next:
      FindNext $Fh $Fn
      Goto un_keep_loop
    un_keep_done:
    FindClose $Fh
    DetailPrint "Kept your data in: $INSTDIR\data"
    Goto un_fin

  un_wipe:
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  RMDir "$INSTDIR"

  un_fin:
SectionEnd
