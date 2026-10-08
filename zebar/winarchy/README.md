# Winarchy

Omarchy-inspired desktop bar for Windows, powered by Zebar.

## Startup

`zebar/settings.json` selects `winarchy / bar / default` as the only startup widget. GlazeWM launches Zebar on startup and stops it on shutdown; the existing Windows GlazeWM autostart therefore also starts Winarchy after sign-in. Restarting Zebar or GlazeWM loads Winarchy automatically. The popup is preloaded by the bar, not separately configured as a startup widget.

## Source layout

The widget HTML files contain markup only. `widgets/bar/bar.css` and
`widgets/bar/bar.mjs` own the bar's styles and behavior. The reusable popup loads
`widgets/popup/popup.css` and `widgets/popup/bootstrap.mjs`, which resets the
session DOM and starts the calendar or system dispatcher.

`widgets/popup/system.mjs` dispatches to the individual Audio, Network, Battery,
Bluetooth, Display and GlobalProtect renderers. Shared popup DOM helpers live in
`dom.mjs`; `providers.mjs` handles session-scoped provider subscriptions. Models,
native bridges, caches and window lifecycle helpers remain under `widgets/shared`.
All assets are included by the existing widget file globs; no build step is needed.

Obsolete system/drive rendering and session-action helpers, styles and permissions
have been removed. Restart Zebar after updating to unload the old shutdown,
logout and lock permissions.

## Bar background

The bar uses Catppuccin Mocha Base (`#1e1e2e`). Its native window stays topmost so neighboring window shadows cannot darken the background when focus changes. GlazeWM fullscreen temporarily switches it to the normal layer so fullscreen can still cover the bar. Workspace highlights are unchanged. Restart Zebar after changing the initial layer in `zpack.json`.

## Reusable popups

Restart Zebar after updating. Bar startup preloads one native popup WebView and all its modules in the background. It starts as a transparent, nonfocused 1px surface outside the entire virtual desktop, then hides itself without rendering providers or waiting for animation frames. All monitor bars share one startup lock and cache, so they do not create duplicate windows. Once startup finishes, even the first click reuses the loaded WebView. A click during startup waits for completion; if prewarming fails, a real click retries normally.

Subsequent openings, type changes and moves between monitor bars reuse the same WebView. Closing hides the window instead of destroying it. One hidden WebView stays alive until Zebar exits. No extra npm build or local SDK bundle is needed.

Each opening gets fresh content and a new request ID. Hiding or replacing a session stops its providers, timers, sizing observer and storage/resize listeners; no popup polling continues while hidden. Provider unsubscriptions finish before the next session subscribes to the same config. Stale focus/outside-click requests cannot dismiss a replacement, and a destroyed or failed cached window is recreated on the next click. The native window is shown while CSS is still transparent before waiting for paint, because hidden WebViews can suspend animation frames.

## Audio crash workaround

Only the persistent monitor bars subscribe to Zebar's native audio provider. The Audio popup receives serializable snapshots through `BroadcastChannel` and routes volume/mute commands to one responding bar, so multi-monitor desktops do not execute a command twice. Closing/replacing the popup closes only its channel, timer and pending requests; it never creates, stops or restarts the native audio provider. Device selection remains the existing narrowly permitted one-shot popup shell command; subsequent state comes from the bar.

This avoids Zebar 3.3.1 stopping its shared audio provider on popup close and leaving an endpoint notification callback registered after freeing it. Command failures/timeouts are reported without automatic retries. Missing bars disable controls; there is deliberately no fallback native popup provider. This is a lifecycle workaround, not a fix for all native audio bugs. Restart Zebar once after updating to discard any callbacks left behind by the old code. No upstream changes or additional shell permissions are required.

## Display popup

The Display popup is a minimal, read-only panel matching the other Omarchy-style popups: monospace typography, square accent border, flat sections and monitor rows. It shows the current monitor's Windows scale and connected displays, with the current monitor highlighted. Resolution and per-monitor scale are available in each row's tooltip. There are no settings links, brightness/text-size controls, refresh buttons or explanatory footers. Data is refreshed on each opening using Zebar's monitor API; no shell commands or extra display permissions are needed. Restart Zebar to unload the previously added display-helper permissions.

## Battery popup

The compact battery popup shows charge, a charge bar, full-charge capacity (Wh), cycles, time to full and charging/discharging watts. Missing firmware data is shown as `—`. Capacity is queried once per opening with a read-only Windows CIM command; the other values come from Zebar. System/drive details, health and session actions are removed. Power-profile controls are intentionally omitted because Windows power modes are not uniformly available through simple power-plan commands. Restart Zebar to load the added capacity-query permission.

## Bluetooth background status

The bar refreshes the status of known/paired Bluetooth devices every 30 seconds, including while the popup is closed. One monitor bar holds a polling lease to avoid duplicate background queries. Only paired/connected devices are cached; nearby discovery runs exclusively while the popup is open (every 10 seconds, with an eight-second native search and no overlapping scans). The popup displays the paired cache immediately, then refreshes live status. Late background reads do not overwrite a newer popup cache. Query failures preserve the last cached display; blocked storage disables background polling without affecting the popup's live queries. Restart Zebar after changing `zpack.json` to load the bar's added status-only permission; pairing, discovery and radio changes remain popup-only.

## Dedicated GlobalProtect popup

A custom globe/shield icon sits first in the bar's right-hand area, before Bluetooth. It is visible only when GlobalProtect is installed in its standard location, muted when disconnected and full foreground when connected. It uses the existing background status poll and shared snapshots, including updates from the VPN popup.

The GlobalProtect popup provides a Connect/Disconnect switch and a small Open client action for the official Windows GlobalProtect client installed under `%ProgramFiles%\Palo Alto Networks\GlobalProtect\PanGPA.exe`. Restart Zebar after changing `zpack.json` so it loads the new narrowly scoped shell permissions.

Before sending Connect/Disconnect, the helper moves only the verified GlobalProtect main window beside the visible Zebar popup: right first, then left, below or above, with a 12-physical-pixel gap. Placement uses per-monitor DPI-aware physical coordinates and the popup monitor's working area, without resizing, changing z-order or activating the window. Login/MFA windows and explicit Open client requests are not moved. If no non-overlapping position fits or Windows rejects the move, the VPN action still proceeds and the popup reports a placement warning. The client can briefly overlap while initially opening, and may reposition itself afterward. This adds native window control to the existing PowerShell helper; Cortex compatibility is not guaranteed. Automatic hiding after confirmed VPN state remains unchanged.

The Network popup shows the actual Wi-Fi SSID and a compact two-column overview (gateway ping, receiving/sending rates, adapter byte totals, IP address and link rate). VPN controls are now exclusively in the GlobalProtect popup. The overview places Link rate beside Ping and Gateway beside IP Address. Click either IP Address or Gateway value (or focus it and press Enter/Space) to copy that address to the clipboard; unavailable values are not interactive. Rates appear after two samples; totals are Windows adapter counters, not usage since opening the popup. Ping measures the local gateway, not internet reachability. DNS controls and WLAN selection are omitted: the native WLAN scan terminated without diagnostics on this machine, so joining networks remains in Windows Settings. The header arrow button opens the native Windows network selection flyout (`ms-availablenetworks:`), with the same arrow, transparent square button and hover/focus outline as the GlobalProtect Open client action. Before opening the native flyout, Zebar hides the Network popup and allows a short focus-transition interval, then sends the URI once. This avoids a late popup focus change interfering with cold-start flyout activation; no second invocation is sent because it could toggle the flyout closed. Explorer is started with `shellSpawn`: URI activation is asynchronous, so its eventual exit code and flyout startup time are not treated as failure. Only an actual process-start failure restores the original popup and reports the error. The exact flyout presentation depends on the Windows version. Wi-Fi power and joining networks are handled by Windows, not a PowerShell/WinRT radio helper. The helper and its shell permissions were removed because Cortex XDR blocked its status script (`ioc.amsi_static_invocation`) and terminated the GlazeWM → Zebar process chain. Without radio queries, the popup reports connection state but does not distinguish powered-off Wi-Fi from disconnected Wi-Fi. Restart Zebar to unload the old scripts and permissions. Ethernet keeps its IP overview and speed in the hero. Connection details are omitted; explanatory status/MFA text appears only when needed. The persistent bar polls connection, traffic and VPN status every 30 seconds, even when the popup is closed. An open Network popup polls network data every second; an open GlobalProtect popup polls VPN status every second; busy guards prevent overlapping native queries. One monitor bar holds a short-lived polling lease to avoid duplicate queries on multi-monitor desktops. Results are shared through localStorage; the popup uses fresh background results for its initial display, then makes its own one-second queries. Fresh background status (at most 35 seconds old) is usable immediately; older display-cache values expire after two minutes and keep switches disabled until a live query succeeds. No credentials or pending operations are stored. If the bar, background queries or storage are unavailable, the popup falls back to its own queries. Restart Zebar to load the bar's added status-only permissions; actions remain popup-only.

Status is polled every second while the popup is open (every 30 seconds by the background bar) from the PANGP/GlobalProtect adapter (up, with a non-link-local IPv4 address), independently of the default route, so split tunnels are included. This is an adapter-level indication, not an internet or gateway reachability test.

Actions open the existing client and send one bounded Windows `BM_CLICK` to its verified, enabled, visible Connect or Disconnect button. Tested with GlobalProtect 6.3.3 and English button labels, ID `1160`. No passwords are stored, no adapters or services are toggled, and MFA/SSO remain in the official client. Changes to the client UI, language, or company policy can prevent automation; Open client remains the manual fallback.

An accepted click is shown as pending until adapter status matches. At the first matching status poll (normally within one second), the popup hides only the verified GlobalProtect main window using Windows `ShowWindowAsync(SW_HIDE)`; it does not terminate the client or hide separate login/MFA windows. While login/MFA is pending or an operation fails, the client remains available. Explicitly choosing Open client during a pending operation cancels automatic hiding for that operation. An already dismissed client is left alone. Restart Zebar to load the updated shell permissions. If login or disconnection does not complete within two minutes, check the official client before retrying. The GlobalProtect popup stays open while Connect/Disconnect is pending, including focus changes and clicks in the client/MFA window. Normal focus-loss and outside-click dismissal resume when adapter status matches or the operation times out; Escape and the bar toggle still close it immediately. Retention has a bounded fallback deadline if the operation or WebView fails.

## Tests

```sh
node --experimental-vm-modules --test zebar/winarchy/tests/*.test.mjs
```

Run from the `.glzr` directory. On Windows, the browser suite uses installed Edge with mocked native APIs; it does not connect or disconnect the real VPN.
