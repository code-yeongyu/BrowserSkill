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

- **Finding:** the reported ~60 s CPU tail after `session stop` is not a cost the extension keeps running. The stop path returns tabs, clears refs, detaches CDP and closes the agent window, and the agent window's renderer exits at stop. In two runs on store 0.3.2, the GPU process was back near its baseline within 30 s in one run (33, 24, 26% vs a 36% baseline) and stayed above it in the other (46-55% vs 28%), while page renderers that belong to the owner's own tabs moved independently of the session. The extension's worker shows a short burst right after stop (stop handling, then MV3 idle shutdown about 30 s later), which is expected. No code change was made for the tail.

### Measurements

Percent of one core, mean over each window. `gpu` = GPU process, `ext` = all extension processes, `total` = all browser processes.

| Run | Build | baseline total / gpu | session total / gpu | post 0-30 s gpu | post 30-60 s gpu | post 60-90 s gpu |
| --- | --- | --- | --- | --- | --- | --- |
| before-1 | store 0.3.2 | 91 / 28 | 339 / 133 | 45 | 51 | 55 |
| before-2 | store 0.3.2 | 152 / 36 | 283 / 107 | 33 | 24 | 26 |
