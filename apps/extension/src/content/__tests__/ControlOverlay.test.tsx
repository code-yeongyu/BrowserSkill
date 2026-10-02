import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlOverlay } from "../ControlOverlay";

describe("ControlOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps page blocker none under automationBypass but Interrupt stays clickable", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={true}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("none");

    const pill = container.querySelector("[data-slot='control-overlay-pill']");
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.pointerEvents).toBe("auto");

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    expect(stopBtn).toBeTruthy();
    expect((stopBtn as HTMLElement).style.pointerEvents).toBe("auto");
  });

  it("uses pointer-events auto on blocker when automationBypass is false", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("auto");
  });

  it("keeps the control glow idle instead of animating forever", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        onInterrupt={() => {}}
      />,
    );

    const glow = container.querySelector<HTMLElement>("[data-slot='control-overlay']");
    expect(glow?.style.boxShadow).not.toBe("");
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).not.toMatch(/infinite/);
    expect(css).not.toMatch(/@keyframes[^}]*\{[^}]*box-shadow/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[^}]*animation: none/);
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.style.animation).not.toMatch(/infinite/);
    }
  });

  it("calls onInterrupt from the stop button", () => {
    const onInterrupt = vi.fn();
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        onInterrupt={onInterrupt}
      />,
    );

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    (stopBtn as HTMLButtonElement).click();

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
