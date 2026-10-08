#Requires AutoHotkey v2.0
#SingleInstance Force

; Keep Windows-key shortcuts working, but suppress the Start menu.
; SendEvent keeps the keyboard hook installed, unlike SendInput.
~LWin::SendEvent "{Blind}{vkE8}"
~RWin::SendEvent "{Blind}{vkE8}"
