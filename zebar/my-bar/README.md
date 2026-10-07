# My bar

## GlobalProtect in the Network popup

The Network popup provides a Connect/Disconnect switch and a small Open client action for the official Windows GlobalProtect client installed under `%ProgramFiles%\Palo Alto Networks\GlobalProtect\PanGPA.exe`. Restart Zebar after changing `zpack.json` so it loads the new narrowly scoped shell permissions.

The default view shows the connection hero, IP address, Wi-Fi link rate (Ethernet speed is already in the hero), and one GlobalProtect row. Adapter, IPv6, and default-route tunnel diagnostics are available under Connection details; explanatory status/MFA text appears only when needed.

Status is polled every five seconds from the PANGP/GlobalProtect adapter (up, with a non-link-local IPv4 address), independently of the default route, so split tunnels are included. This is an adapter-level indication, not an internet or gateway reachability test.

Actions open the existing client and send one bounded Windows `BM_CLICK` to its verified, enabled, visible Connect or Disconnect button. Tested with GlobalProtect 6.3.3 and English button labels, ID `1160`. No passwords are stored, no adapters or services are toggled, and MFA/SSO remain in the official client. Changes to the client UI, language, or company policy can prevent automation; Open client remains the manual fallback.

An accepted click is shown as pending until adapter status matches. If login or disconnection does not complete within two minutes, check the official client before retrying. The Network popup stays open while Connect/Disconnect is pending, including focus changes and clicks in the client/MFA window. Normal focus-loss and outside-click dismissal resume when adapter status matches or the operation times out; Escape and the bar toggle still close it immediately. Retention has a bounded fallback deadline if the operation or WebView fails.

## Tests

```sh
node --experimental-vm-modules --test zebar/my-bar/tests/*.test.mjs
```

Run from the `.glzr` directory. On Windows, the browser suite uses installed Edge with mocked native APIs; it does not connect or disconnect the real VPN.
