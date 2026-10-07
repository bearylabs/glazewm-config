#Requires AutoHotkey v2.0
#SingleInstance Force

; Keep Windows-key shortcuts working, but suppress the Start menu.
; vkE8 is an unassigned key used to mask standalone Windows-key presses.
~LWin::Send "{Blind}{vkE8}"
~RWin::Send "{Blind}{vkE8}"
