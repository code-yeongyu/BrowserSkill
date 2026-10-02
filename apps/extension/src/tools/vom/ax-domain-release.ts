import type { CdpTarget } from "@/browser-driver/frame-graph";
import { type CdpRunner, cdpRunnerForTarget } from "../shared";

/**
 * `Accessibility.enable` switches the renderer into accessibility mode, which
 * keeps the AX tree updated on every DOM and layout change until the domain is
 * disabled or the debugger detaches. A capture needs the tree only while it
 * reads it, so release the domain once the reads are done; the next capture
 * enables it again. Refs are keyed by backend DOM node id, not AX node id, so
 * nothing relies on AX ids staying stable across captures.
 *
 * Callers skip targets whose reads timed out (a command sent there would queue
 * behind the pending read) and schedule releases through the capture's worker
 * pool. A failed release is logged and never fails the capture.
 */
export async function releaseAccessibilityDomain(
  cdp: CdpRunner,
  tabId: number,
  target: CdpTarget,
): Promise<void> {
  await cdpRunnerForTarget(cdp, target)
    .send(tabId, "Accessibility.disable", {})
    .catch((error: unknown) => {
      console.debug("[bsk vom] Accessibility.disable failed", { tabId, error });
    });
}
