# Fork changes

Every change this fork carries on top of [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) `main`, newest first. Each entry says why and what it measurably did. The diff is kept small so it rebases cleanly; anything general is offered upstream.

Measurement method (all entries): one `bsk` session on a real, in-use Chromium-based browser on macOS (Apple Silicon): 30 s idle baseline, then `session start --no-focus`, `navigate`, `observe` x3, `snapshot` x3, `click`, `screenshot` x2, `evaluate` x3 with 5 s gaps, `session stop`, then 90 s idle. CPU of every browser process is sampled from `ps` once a second and grouped by process role (browser, GPU, extension, page renderers, agent-window renderer). Values are percent of one core, averaged over the window. The browser is in normal use by its owner during the run, so the baseline moves between runs; compare each run's session window to its own baseline.

## 2026-10-02 - Cheap control overlay, release accessibility mode after each capture

Upstream base: `3f10983` (0.3.2).

### Control overlay no longer repaints every frame

- **Why:** `ControlOverlay.tsx` drew the "agent is in control" glow as a full-viewport `div` with `animation: bsk-breathe 3s ease-in-out infinite`, and `bsk-breathe` animated an inset `box-shadow`. `box-shadow` is not compositor-animatable, so the whole viewport was repainted every frame for as long as a session was open, even while the agent was idle between commands. It ignored `prefers-reduced-motion`.
- **Change:** the glow is a static inset shadow, painted once. A second, pre-painted shadow layer pulses its `opacity` (compositor-only, no repaint) for two 3 s cycles when control starts, then rests. `prefers-reduced-motion: reduce` turns the pulse off. Hidden tabs don't render, and after the onset pulse nothing is left to pause. The overlay still says what it said: a warm edge glow plus the "Agent is controlling" pill.
- **Files:** `apps/extension/src/content/ControlOverlay.tsx`; test in `src/content/__tests__/ControlOverlay.test.tsx` (no infinite animation, no `box-shadow` keyframes, reduced-motion rule present).
- **Measured:** see the table below.

### Accessibility domain released after each observe/snapshot

- **Why:** every `observe`/`snapshot` sent `Accessibility.enable` and never disabled it. The CDP docs say enabling the domain "turns on accessibility for the page, which can impact performance until accessibility is disabled": the renderer then keeps the AX tree updated on every DOM and layout change for the rest of the session.
- **Change:** after the capture has read the full AX tree, the capture sends `Accessibility.disable` to every target whose AX reads finished (targets with a timed-out read are skipped so nothing queues behind the pending read). It goes through the capture's existing 4-worker pool. A failed disable is logged and never fails the capture. Refs are keyed by backend DOM node id, so nothing depends on AX node ids staying stable across captures.
- **Not done:** caching or diffing the full AX tree between unchanged captures. CDP has no cheap "unchanged since" token for the AX tree, and a stale cache would hand the agent wrong refs. Releasing the domain removes the ongoing cost. The per-call read remains.
- **Files:** `apps/extension/src/tools/vom/ax-domain-release.ts` (new), one call in `src/tools/vom/capture-coordinator.ts`; tests in `src/tools/__tests__/accessibility-release.test.ts` (released after the read and refs still resolve; re-enabled on the next capture; a failed release still returns the snapshot).
- **Measured:** see the table below.

### Post-stop tail

- **Finding:** the reported ~60 s CPU tail after `session stop` is not caused by the extension. The stop path returns tabs, clears refs, detaches CDP and closes the agent window, and the agent window's renderer exits at stop. In an isolated browser profile (controlled A/B below), every process is back at its idle baseline within 30 s of `session stop` for both the store build and this fork. In the owner's in-use browser the post-stop numbers moved with the owner's own tabs (back at baseline in one run, above it in the other). No code change was needed for the tail.

### Measurements

Percent of one core, mean over each window. `gpu` = GPU process, `total` = all browser processes.

**Controlled A/B (2026-10-02).** A fresh headless Chrome for Testing 154 profile per run, with only the extension under test loaded unpacked, connected to the same `bsk` daemon as its own browser instance. Builds alternate so machine load hits both equally. This isolates the extension from everything else the browser is doing.

| Run | Build | baseline total / gpu | session total / gpu | post 0-30 s total | post 30-90 s total |
| --- | --- | --- | --- | --- | --- |
| 01 | store 0.3.2 | 3.2 / 1.7 | 37.2 / 21.5 | 1.2 | 0.4, 0.1 |
| 02 | fork `1cea851` | 3.1 / 1.1 | 14.9 / 6.7 | 0.9 | 0.2, 0.1 |
| 03 | store 0.3.2 | 2.0 / 0.8 | 33.5 / 19.5 | 1.3 | 0.2, 0.1 |
| 04 | fork `1cea851` | 2.1 / 0.9 | 10.1 / 4.4 | 0.7 | 0.3, 0.4 |

Mean over the two pairs: during a session the GPU process drops from 20.5% to 5.6% (-73%) and the whole browser from 35.4% to 12.5% (-65%) of one core. After stop, both builds are at baseline within 30 s.

**Owner's in-use browser, store build (before the switch).** Same sequence, in the browser the owner was actively using, so baselines are noisy:

| Run | Build | baseline total / gpu | session total / gpu | post 0-30 s gpu | post 30-60 s gpu | post 60-90 s gpu |
| --- | --- | --- | --- | --- | --- | --- |
| before-1 | store 0.3.2 | 91 / 28 | 339 / 133 | 45 | 51 | 55 |
| before-2 | store 0.3.2 | 152 / 36 | 283 / 107 | 33 | 24 | 26 |
