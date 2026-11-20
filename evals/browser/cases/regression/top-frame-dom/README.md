# Top-frame DOM cooperation regression

Run from the repository root with a full Chrome for Testing executable and the
workspace dependencies installed:

```sh
cargo build --locked -p bsk --bin bsk
BSK_DAEMON_WS_URL=ws://127.0.0.1:52929 pnpm ext:build
BSK_COOP_CHROME=/path/to/chrome node --test evals/browser/cases/regression/top-frame-dom/run.mjs
```

The suite launches a disposable Chrome profile, daemon, and loopback fixture
server. The two unpacked test extensions independently reproduce the debugger
denial and host the foreign iframe. The tests then exercise the built BrowserSkill
extension through the daemon, not through the independent driver. The driver
only prepares and inspects the fixture and verifies the browser precondition.
No external page or existing browser profile is used.

If the test daemon's port is occupied, choose another port and set
`BSK_TOP_FRAME_PORT` to that value when running the suite. Use the same port in
`BSK_DAEMON_WS_URL` when building the extension.
