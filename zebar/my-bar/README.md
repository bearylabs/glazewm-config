# My bar

## Bar background

The bar uses Catppuccin Mocha Base (`#1e1e2e`). Its native window stays topmost so neighboring window shadows cannot darken the background when focus changes. GlazeWM fullscreen temporarily switches it to the normal layer so fullscreen can still cover the bar. Workspace highlights are unchanged. Restart Zebar after changing the initial layer in `zpack.json`.

## Reusable popups

Restart Zebar after updating. Bar startup preloads one native popup WebView and all its modules in the background. It starts as a transparent, nonfocused 1px surface outside the entire virtual desktop, then hides itself without rendering providers or waiting for animation frames. All monitor bars share one startup lock and cache, so they do not create duplicate windows. Once startup finishes, even the first click reuses the loaded WebView. A click during startup waits for completion; if prewarming fails, a real click retries normally.

Subsequent openings, type changes and moves between monitor bars reuse the same WebView. Closing hides the window instead of destroying it. One hidden WebView stays alive until Zebar exits. No extra npm build or local SDK bundle is needed.

Each opening gets fresh content and a new request ID. Hiding or replacing a session stops its providers, timers, sizing observer and storage/resize listeners; no popup polling continues while hidden. Provider unsubscriptions finish before the next session subscribes to the same config. Stale focus/outside-click requests cannot dismiss a replacement, and a destroyed or failed cached window is recreated on the next click. The native window is shown while CSS is still transparent before waiting for paint, because hidden WebViews can suspend animation frames.

## GlobalProtect in the Network popup

The Network popup provides a Connect/Disconnect switch and a small Open client action for the official Windows GlobalProtect client installed under `%ProgramFiles%\Palo Alto Networks\GlobalProtect\PanGPA.exe`. Restart Zebar after changing `zpack.json` so it loads the new narrowly scoped shell permissions.

The default view shows the actual Wi-Fi SSID, a compact two-column overview (gateway ping, receiving/sending rates, adapter byte totals, IP address and link rate), and one GlobalProtect row. Rates appear after two samples; totals are Windows adapter counters, not usage since opening the popup. Ping measures the local gateway, not internet reachability. DNS controls and WLAN selection are omitted: the native WLAN scan terminated without diagnostics on this machine, so joining networks remains in Windows Settings. The header arrow button opens the native Windows network selection flyout (`ms-availablenetworks:`), with the same arrow, transparent square button and hover/focus outline as the GlobalProtect Open client action. The exact flyout presentation depends on the Windows version. Wi-Fi power and joining networks are handled by Windows, not a PowerShell/WinRT radio helper. The helper and its shell permissions were removed because Cortex XDR blocked its status script (`ioc.amsi_static_invocation`) and terminated the GlazeWM → Zebar process chain. Without radio queries, the popup reports connection state but does not distinguish powered-off Wi-Fi from disconnected Wi-Fi. Restart Zebar to unload the old scripts and permissions. Ethernet keeps its IP overview and speed in the hero. Connection details are omitted; explanatory status/MFA text appears only when needed. The persistent bar polls connection, traffic and VPN status every 30 seconds, even when the popup is closed. An open Network popup polls every second; busy guards prevent overlapping native queries. One monitor bar holds a short-lived polling lease to avoid duplicate queries on multi-monitor desktops. Results are shared through localStorage; the popup uses fresh background results for its initial display, then makes its own one-second queries. Fresh background status (at most 35 seconds old) is usable immediately; older display-cache values expire after two minutes and keep switches disabled until a live query succeeds. No credentials or pending operations are stored. If the bar, background queries or storage are unavailable, the popup falls back to its own queries. Restart Zebar to load the bar's added status-only permissions; actions remain popup-only.

Status is polled every second while the popup is open (every 30 seconds by the background bar) from the PANGP/GlobalProtect adapter (up, with a non-link-local IPv4 address), independently of the default route, so split tunnels are included. This is an adapter-level indication, not an internet or gateway reachability test.

Actions open the existing client and send one bounded Windows `BM_CLICK` to its verified, enabled, visible Connect or Disconnect button. Tested with GlobalProtect 6.3.3 and English button labels, ID `1160`. No passwords are stored, no adapters or services are toggled, and MFA/SSO remain in the official client. Changes to the client UI, language, or company policy can prevent automation; Open client remains the manual fallback.

An accepted click is shown as pending until adapter status matches. At the first matching status poll (normally within one second), the popup hides only the verified GlobalProtect main window using Windows `ShowWindowAsync(SW_HIDE)`; it does not terminate the client or hide separate login/MFA windows. While login/MFA is pending or an operation fails, the client remains available. Explicitly choosing Open client during a pending operation cancels automatic hiding for that operation. An already dismissed client is left alone. Restart Zebar to load the updated shell permissions. If login or disconnection does not complete within two minutes, check the official client before retrying. The Network popup stays open while Connect/Disconnect is pending, including focus changes and clicks in the client/MFA window. Normal focus-loss and outside-click dismissal resume when adapter status matches or the operation times out; Escape and the bar toggle still close it immediately. Retention has a bounded fallback deadline if the operation or WebView fails.

## Tests

```sh
node --experimental-vm-modules --test zebar/my-bar/tests/*.test.mjs
```

Run from the `.glzr` directory. On Windows, the browser suite uses installed Edge with mocked native APIs; it does not connect or disconnect the real VPN.
