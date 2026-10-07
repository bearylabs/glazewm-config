# My bar

## GlobalProtect in the Network popup

The Network popup provides a Connect/Disconnect switch and a small Open client action for the official Windows GlobalProtect client installed under `%ProgramFiles%\Palo Alto Networks\GlobalProtect\PanGPA.exe`. Restart Zebar after changing `zpack.json` so it loads the new narrowly scoped shell permissions.

The default view shows the actual Wi-Fi SSID, a compact two-column overview (gateway ping, receiving/sending rates, adapter byte totals, IP address and link rate), and one GlobalProtect row. Rates appear after two samples; totals are Windows adapter counters, not usage since opening the popup. Ping measures the local gateway, not internet reachability. DNS controls and WLAN selection are omitted: the native WLAN scan terminated without diagnostics on this machine, so joining networks remains in Windows Settings. The header switch controls the Windows Wi-Fi radio through WinRT (not adapter disabling); status is polled every five seconds and denied access is shown inline. Restart Zebar to load the fixed statistics and radio permissions. Ethernet keeps its IP overview and speed in the hero. Connection details are omitted; explanatory status/MFA text appears only when needed. The persistent bar polls connection, traffic, WLAN radio and VPN status every five seconds, even when the popup is closed. One monitor bar holds a short-lived polling lease to avoid duplicate queries on multi-monitor desktops. Results are shared through localStorage; an open popup follows storage updates without duplicating fresh background queries. Fresh background status (at most 7.5 seconds old) is usable immediately; older display-cache values expire after two minutes and keep switches disabled until a live query succeeds. Wi-Fi actions recheck the native radio before changing power. No credentials or pending operations are stored. If the bar, background queries or storage are unavailable, the popup falls back to its own queries. Restart Zebar to load the bar's added status-only permissions; actions remain popup-only.

Status is polled every five seconds from the PANGP/GlobalProtect adapter (up, with a non-link-local IPv4 address), independently of the default route, so split tunnels are included. This is an adapter-level indication, not an internet or gateway reachability test.

Actions open the existing client and send one bounded Windows `BM_CLICK` to its verified, enabled, visible Connect or Disconnect button. Tested with GlobalProtect 6.3.3 and English button labels, ID `1160`. No passwords are stored, no adapters or services are toggled, and MFA/SSO remain in the official client. Changes to the client UI, language, or company policy can prevent automation; Open client remains the manual fallback.

An accepted click is shown as pending until adapter status matches. If login or disconnection does not complete within two minutes, check the official client before retrying. The Network popup stays open while Connect/Disconnect is pending, including focus changes and clicks in the client/MFA window. Normal focus-loss and outside-click dismissal resume when adapter status matches or the operation times out; Escape and the bar toggle still close it immediately. Retention has a bounded fallback deadline if the operation or WebView fails.

## Tests

```sh
node --experimental-vm-modules --test zebar/my-bar/tests/*.test.mjs
```

Run from the `.glzr` directory. On Windows, the browser suite uses installed Edge with mocked native APIs; it does not connect or disconnect the real VPN.
