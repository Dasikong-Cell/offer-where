; ===========================================================================
; OfferWhere -- installer UI strings that MUI does NOT ship
;
; WHY THIS FILE EXISTS
;   MUI's SimpChinese language file covers the stock pages (title, subtitle,
;   buttons), but text WE author -- a component name, its description -- has
;   nowhere to live except a script file. offerwhere.nsi is held to pure ASCII
;   on purpose (there is a contract test for it): one non-ASCII byte there and
;   the build starts depending on the code page of whichever machine happens to
;   run makensis, which is exactly how the .ps1 evidence scripts got burned.
;
; WHY THE BOM IS HERE (measured, not assumed -- 2026-09-29)
;   Script encoding IS an input makensis cares about: it prints "(ACP)" while
;   processing the ASCII main script. What it does with UTF-8 depends on the
;   build. Measured here on NSIS 3.11: a UTF-8 file decodes correctly WITH or
;   WITHOUT a BOM -- verified both ways by pulling the UTF-16LE strings back out
;   of the finished exe, not by trusting that a successful build means correct
;   bytes. (An earlier draft of this comment claimed dropping the BOM breaks the
;   build. That was wrong: the failing builds were MSYS rewriting the compiler's
;   arguments, which made the SAME script fail intermittently and invited the
;   wrong diagnosis. Drive makensis with a Python argv list, never through bash.)
;   The BOM is kept because NSIS's OWN SimpChinese.nsh ships UTF-8-with-BOM, and
;   because a BOM removes the question entirely for any other makensis version
;   (CI has run 3.10 and 3.13). It is deliberate -- do not tidy it away.
;
; MUST BE INCLUDED AFTER MUI_LANGUAGE
;   LangString resolves ${LANG_SIMPCHINESE}, which only exists once the language
;   file is loaded. Include this earlier and the strings quietly come out empty.
; ===========================================================================

LangString STR_SEC_CORE          ${LANG_SIMPCHINESE} "OfferWhere 主程序（必需）"
LangString STR_SEC_CORE_DESC     ${LANG_SIMPCHINESE} "解压 OfferWhere 并创建开始菜单项与卸载入口。这一项必须安装。"
LangString STR_SEC_DESKTOP       ${LANG_SIMPCHINESE} "在桌面上创建快捷方式"
LangString STR_SEC_DESKTOP_DESC  ${LANG_SIMPCHINESE} "默认勾选。不想在桌面留图标就取消，开始菜单里仍然能启动。"
