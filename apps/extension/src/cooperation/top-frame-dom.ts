import {
  RECORD_PASSWORD_ATTRIBUTE,
  SENSITIVE_AUTOCOMPLETE_SELECTOR,
} from "@/lib/sensitive-autocomplete";
import type { RpcError } from "@/transport/types";
import type { ActionExpectation } from "./action-checks";

type DomReason =
  | "top_frame_injection_denied"
  | "stale_context"
  | "stale_target"
  | "target_unobservable"
  | "target_in_foreign_extension_frame"
  | "target_covered"
  | "unsupported_in_degraded_mode"
  | "dom_dispatch_opt_in_required"
  | "guard_mismatch"
  | "synthetic_input_unconfirmed"
  | "human_intervention"
  | "operation_settling";

const messages: Record<DomReason, string> = {
  top_frame_injection_denied: "Chrome did not allow access to the top document",
  stale_context: "The top-document control context is no longer current",
  stale_target: "The observed element changed or was replaced",
  target_unobservable: "The target is not part of this top-document observation",
  target_in_foreign_extension_frame: "The target belongs to a foreign extension frame",
  target_covered: "The observed control is covered or outside the viewport",
  unsupported_in_degraded_mode: "This operation is not supported by top-frame DOM control",
  dom_dispatch_opt_in_required:
    "This action requires explicit acceptance of synthetic DOM dispatch",
  guard_mismatch: "A live target condition did not match the caller's expectation",
  synthetic_input_unconfirmed:
    "The synthetic action was sent but its result could not be confirmed",
  human_intervention: "Human activity revoked top-frame control",
  operation_settling: "The previous top-frame action is still settling",
};

export const domError = (
  reason: DomReason,
  effect: "none" | "unknown" = "none",
  rendererSettled = false,
): RpcError => ({
  code: "permission_denied",
  message: messages[reason],
  data: {
    reason,
    phase: effect === "none" ? "precondition" : "dispatch",
    effect_state: effect,
    ...(rendererSettled ? { renderer_settled: true } : {}),
    recovery:
      effect === "unknown"
        ? "Inspect the application result before resolving the pending intent. Do not replay it."
        : "Synchronize the intended tab and inspect the result before choosing another action.",
  },
});

export const domMode = {
  backend: "top_frame_dom",
  frame_scope: "top",
  ax_available: false,
  input_trust: "synthetic",
  supported_actions: ["fill", "click"],
  observation_gaps: ["child_frames", "accessibility_tree"],
} as const;

/** This only classifies browser-owned inventory, never a DOM iframe's claimed src. */
export function isForeignExtensionFrame(
  frame: { readonly frameId: number; readonly url: string },
  extensionId: string,
): boolean {
  if (frame.frameId === 0 || !frame.url.startsWith("chrome-extension://")) return false;
  try {
    return new URL(frame.url).hostname !== extensionId;
  } catch {
    return false;
  }
}

export interface DomContext {
  readonly id: string;
  readonly documentId: string;
  readonly epoch: number;
}

type DomInput =
  | {
      readonly kind: "fill";
      readonly value: string;
    }
  | { readonly kind: "click" };

export interface DomAction {
  readonly ref: string;
  readonly expect: readonly ActionExpectation[];
  readonly operationId: string;
  readonly input: DomInput;
}

type DomCommand = { readonly scope: string; readonly sensitiveSelector: string } & (
  | { readonly kind: "observe"; readonly limit: number }
  | { readonly kind: "arm"; readonly action: DomAction }
  | { readonly kind: "commit"; readonly action: DomAction }
  | { readonly kind: "retire"; readonly operationId: string }
);

interface DomTarget {
  readonly ref: string;
  readonly role: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly readonly: boolean;
  readonly covered: boolean;
  readonly value_state?: "empty" | "filled";
}

type DomReceipt =
  | { readonly kind: "refused"; readonly reason: DomReason; readonly sent: boolean }
  | {
      readonly kind: "observation";
      readonly targets: readonly DomTarget[];
      readonly truncated: boolean;
      readonly text: string;
    }
  | { readonly kind: "armed" | "retired" }
  | { readonly kind: "clicked"; readonly x: number; readonly y: number }
  | { readonly kind: "filled"; readonly length: number };

/** Serialized by Chrome. Everything it needs runs inside this extension's isolated world. */
async function inTopDocument(command: DomCommand): Promise<DomReceipt> {
  type Control = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement;
  interface Observed {
    readonly node: Control;
    readonly identity: string;
    readonly parent: Element | null;
    readonly form: HTMLFormElement | null;
  }
  interface Scene {
    readonly scope: string;
    readonly url: string;
    readonly navigation: string | undefined;
    readonly targets: ReadonlyMap<string, Observed>;
    readonly detached: WeakSet<Element>;
    readonly armed: Map<string, number>;
    readonly consumed: Set<string>;
  }
  interface Slot {
    scene?: Scene;
    drainMutations?: () => void;
    lastHuman: number;
    ownFocus?: Element;
    nextRef: number;
  }
  const host: typeof globalThis & { __bskTopFrameDom?: Slot } = globalThis;
  const refused = (reason: DomReason, sent = false): DomReceipt => ({
    kind: "refused",
    reason,
    sent,
  });
  if (window !== window.top) return refused("stale_context");
  const navigationWindow: Window & {
    navigation?: EventTarget & { currentEntry?: { key: string } };
  } = window;
  if (!host.__bskTopFrameDom) {
    const slot: Slot = { lastHuman: -Infinity, nextRef: 1 };
    host.__bskTopFrameDom = slot;
    const abandon = () => {
      slot.scene = undefined;
    };
    const retireRemoved = (records: readonly MutationRecord[]) => {
      const current = slot.scene;
      if (!current) return;
      for (const record of records) {
        for (const removed of record.removedNodes) {
          for (const { node } of current.targets.values()) {
            if (removed.contains(node)) current.detached.add(node);
          }
        }
      }
    };
    const mutations = new MutationObserver(retireRemoved);
    mutations.observe(document, { childList: true, subtree: true });
    slot.drainMutations = () => retireRemoved(mutations.takeRecords());
    for (const type of ["pointerdown", "wheel", "keydown", "beforeinput", "focusin"]) {
      window.addEventListener(
        type,
        (event) => {
          if (event.isTrusted && !(type === "focusin" && event.target === slot.ownFocus)) {
            slot.lastHuman = performance.now();
            abandon();
          }
        },
        { capture: true, passive: true },
      );
    }
    window.addEventListener("pagehide", abandon);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) abandon();
    });
    window.addEventListener("hashchange", abandon);
    window.addEventListener("popstate", abandon);
    navigationWindow.navigation?.addEventListener("currententrychange", abandon);
  }
  const slot = host.__bskTopFrameDom;
  slot.drainMutations?.();
  const navigation = () => navigationWindow.navigation?.currentEntry?.key;
  const humanActive = () =>
    performance.now() - slot.lastHuman < 700 || document.activeElement instanceof HTMLIFrameElement;
  const eligible = (node: Element): node is Control =>
    !node.matches(command.sensitiveSelector) &&
    (node instanceof HTMLButtonElement ||
      node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLInputElement &&
        ["text", "search", "email", "tel", "url"].includes(node.type)));
  const label = (node: Control) =>
    (
      node.getAttribute("aria-label") ??
      (node.labels?.length
        ? Array.from(node.labels, (item) => item.textContent).join(" ")
        : null) ??
      (node instanceof HTMLButtonElement ? node.textContent : node.getAttribute("placeholder")) ??
      node.name
    )
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 160);
  const identity = (node: Control) =>
    JSON.stringify([
      node.tagName,
      node.id,
      node.name,
      node.type,
      label(node),
      node.getAttribute("formaction"),
      node.getAttribute("formmethod"),
    ]);
  const actionable = (node: Control) =>
    !node.matches(":disabled") &&
    !node.closest("[inert], [aria-disabled=true]") &&
    (node instanceof HTMLButtonElement || !node.readOnly);
  const visible = (node: Control) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return (
      style.visibility === "visible" &&
      style.display !== "none" &&
      box.width > 0 &&
      box.height > 0 &&
      node.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    );
  };
  const point = (node: Control) => {
    const box = node.getBoundingClientRect();
    const left = Math.max(box.left, 0);
    const top = Math.max(box.top, 0);
    const right = Math.min(box.right, innerWidth);
    const bottom = Math.min(box.bottom, innerHeight);
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return left < right && top < bottom && hit && (hit === node || node.contains(hit))
      ? { x, y }
      : undefined;
  };
  if (command.kind === "observe") {
    if (humanActive()) return refused("human_intervention");
    const targets: DomTarget[] = [];
    const refs = new Map<string, Observed>();
    let text = "Top document only; child frames and browser accessibility tree not observed.";
    let truncated = false;
    const nodes = document.querySelectorAll("input, textarea, button");
    for (const [index, node] of nodes.entries()) {
      if (index >= 2048) {
        truncated = true;
        break;
      }
      if (!eligible(node) || !visible(node)) continue;
      const ref = `@e${slot.nextRef++}`;
      const role = node instanceof HTMLButtonElement ? "button" : "textbox";
      const name = label(node);
      const covered = !point(node);
      const disabled = node.matches(":disabled") || !!node.closest("[inert], [aria-disabled=true]");
      const readonly = !(node instanceof HTMLButtonElement) && node.readOnly;
      const valueState =
        node instanceof HTMLButtonElement ? undefined : node.value ? "filled" : "empty";
      const line = `\n${ref} ${role} ${JSON.stringify(name)}${valueState ? ` [${valueState}]` : ""}${disabled ? " disabled" : ""}${readonly ? " readonly" : ""}${covered ? " covered" : ""}`;
      if (text.length + line.length > command.limit || targets.length >= 160) {
        truncated = true;
        break;
      }
      text += line;
      targets.push({
        ref,
        role,
        label: name,
        disabled,
        readonly,
        covered,
        ...(valueState ? { value_state: valueState } : {}),
      });
      refs.set(ref, {
        node,
        identity: identity(node),
        parent: node.parentElement,
        form: node.form,
      });
    }
    slot.scene = {
      scope: command.scope,
      url: location.href,
      navigation: navigation(),
      targets: refs,
      detached: new WeakSet(),
      armed: new Map(),
      consumed: new Set(),
    };
    return { kind: "observation", targets, text, truncated };
  }
  const scene = slot.scene;
  if (
    !scene ||
    scene.scope !== command.scope ||
    scene.url !== location.href ||
    scene.navigation !== navigation()
  )
    return refused("stale_context");
  if (command.kind === "retire") {
    scene.armed.delete(command.operationId);
    return { kind: "retired" };
  }
  if (command.kind === "commit") {
    const deadline = scene.armed.get(command.action.operationId);
    scene.armed.delete(command.action.operationId);
    if (deadline === undefined || performance.now() > deadline) return refused("stale_context");
    scene.consumed.add(command.action.operationId);
  }
  if (humanActive()) return refused("human_intervention");
  const action = command.action;
  const locate = (ref: string) => scene.targets.get(ref.startsWith("@") ? ref : `@${ref}`);
  const visited = locate(action.ref);
  if (!visited) return refused("target_unobservable");
  const { node } = visited;
  const bound = (observed: Observed) =>
    !scene.detached.has(observed.node) &&
    observed.node.ownerDocument === document &&
    observed.node.getRootNode() === document &&
    observed.node.isConnected &&
    eligible(observed.node) &&
    observed.node.parentElement === observed.parent &&
    observed.node.form === observed.form &&
    identity(observed.node) === observed.identity;
  const guard = (): DomReason | undefined => {
    slot.drainMutations?.();
    if (slot.scene !== scene || scene.url !== location.href || scene.navigation !== navigation())
      return "stale_context";
    if (humanActive()) return "human_intervention";
    if (!bound(visited)) return "stale_target";
    if (!actionable(node) || !visible(node)) return "unsupported_in_degraded_mode";
    if (!point(node)) return "target_covered";
    for (const expectation of action.expect) {
      const observed = locate(expectation.target);
      if (!observed || !bound(observed)) return "guard_mismatch";
      const field = observed.node;
      const live =
        expectation.field === "exists"
          ? true
          : expectation.field === "text"
            ? field.textContent
            : expectation.field === "attribute" && expectation.attribute
              ? field.getAttribute(expectation.attribute)
              : expectation.field === "value"
                ? field.value
                : expectation.field === "checked" && field instanceof HTMLInputElement
                  ? field.checked
                  : undefined;
      if (live !== expectation.equals) return "guard_mismatch";
    }
    return undefined;
  };
  if ((action.input.kind === "click") !== node instanceof HTMLButtonElement)
    return refused("unsupported_in_degraded_mode");
  const before = guard();
  if (before) return refused(before);
  if (command.kind === "arm") {
    for (const [id, deadline] of scene.armed) {
      if (performance.now() > deadline) scene.armed.delete(id);
    }
    if (
      scene.armed.size !== 0 ||
      scene.consumed.has(action.operationId) ||
      scene.consumed.size >= 1024
    )
      return refused("operation_settling");
    scene.armed.set(action.operationId, performance.now() + 1500);
    return { kind: "armed" };
  }
  if (action.input.kind === "click") {
    const coords = point(node);
    if (!coords) return refused("target_covered");
    node.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    return slot.scene === scene && location.href === scene.url && navigation() === scene.navigation
      ? { kind: "clicked", ...coords }
      : refused("synthetic_input_unconfirmed", true);
  }
  let sent = false;
  try {
    slot.ownFocus = node;
    sent = true;
    node.focus({ preventScroll: true });
    slot.ownFocus = undefined;
    const afterFocus = guard();
    if (afterFocus || document.activeElement !== node)
      return refused(afterFocus ?? "synthetic_input_unconfirmed", true);
    const prototype =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return refused("synthetic_input_unconfirmed", true);
    const value = action.input.value;
    setter.call(node, value);
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value,
      }),
    );
    if (
      !bound(visited) ||
      slot.scene !== scene ||
      location.href !== scene.url ||
      navigation() !== scene.navigation
    )
      return refused("synthetic_input_unconfirmed", true);
    node.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    return bound(visited) &&
      node.value === value &&
      slot.scene === scene &&
      location.href === scene.url &&
      navigation() === scene.navigation
      ? { kind: "filled", length: node.value.length }
      : refused("synthetic_input_unconfirmed", true);
  } catch {
    return refused("synthetic_input_unconfirmed", sent);
  } finally {
    slot.ownFocus = undefined;
  }
}

export async function topDocument(
  tabId: number,
): Promise<chrome.webNavigation.GetFrameResultDetails | undefined> {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  return frame &&
    (!frame.documentLifecycle || frame.documentLifecycle === "active") &&
    !frame.errorOccurred &&
    /^https?:\/\//u.test(frame.url)
    ? frame
    : undefined;
}

const sensitiveSelector = `[${RECORD_PASSWORD_ATTRIBUTE}],${SENSITIVE_AUTOCOMPLETE_SELECTOR}`;

export async function topDomCall(
  tabId: number,
  context: DomContext,
  command:
    | Omit<Extract<DomCommand, { kind: "observe" }>, "scope" | "sensitiveSelector">
    | Omit<Extract<DomCommand, { kind: "arm" }>, "scope" | "sensitiveSelector">
    | Omit<Extract<DomCommand, { kind: "commit" }>, "scope" | "sensitiveSelector">
    | Omit<Extract<DomCommand, { kind: "retire" }>, "scope" | "sensitiveSelector">,
): Promise<DomReceipt> {
  const rows = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [context.documentId] },
    world: "ISOLATED",
    func: inTopDocument,
    args: [{ ...command, scope: context.id, sensitiveSelector }],
  });
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.frameId !== 0 ||
    row.documentId !== context.documentId ||
    row.result === undefined
  )
    throw new Error("Top document injection returned no verified result");
  return row.result;
}
