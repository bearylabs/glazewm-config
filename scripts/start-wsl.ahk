#Requires AutoHotkey v2.0
#SingleInstance Ignore

RunWait('wsl.exe -d NixOS --exec /run/current-system/sw/bin/sleep infinity', , "Hide")
