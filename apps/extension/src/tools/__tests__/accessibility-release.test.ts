import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { type CdpAxNode, handleSnapshot } from "../observation";

const root: CdpAxNode = {
  nodeId: "1",
  role: { type: "role", value: "RootWebArea" },
  name: { type: "computedString", value: "Example" },
  backendDOMNodeId: 100,
  childIds: ["2"],
};
const button: CdpAxNode = {
  nodeId: "2",
  parentId: "1",
  role: { type: "role", value: "button" },
  name: { type: "computedString", value: "Click" },
  backendDOMNodeId: 200,
};

function agentWindow() {
  return {
    create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
  };
}

function deps(disable: () => Promise<object>) {
  const methods: string[] = [];
  const send = async (_tabId: number, method: string) => {
    methods.push(method);
    if (method === "Accessibility.enable") return {};
    if (method === "Accessibility.disable") return disable();
    if (method === "Accessibility.getFullAXTree") return { nodes: [root, button] };
    if (method === "Page.getLayoutMetrics")
      return {
        visualViewport: { clientWidth: 1000 },
        cssVisualViewport: { clientWidth: 1000 },
        cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
      };
    if (method === "DOMSnapshot.enable") return {};
    if (method === "DOMSnapshot.captureSnapshot") throw new Error("snapshot unsupported");
    throw new Error(`unexpected CDP method ${method}`);
  };
  return {
    methods,
    cdp: {
      send: send as <T = unknown>(tabId: number, method: string, params?: object) => Promise<T>,
      trackSessionTab: vi.fn(),
    },
    tabsApi: {
      get: vi.fn(async (id: number) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab),
      query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
    },
  };
}

describe("accessibility mode during observation", () => {
  it("leaves accessibility mode once the tree has been read, and refs still resolve", async () => {
    const sm = new SessionManager({ agentWindow: agentWindow() });
    const ctx = await sm.start("aa11");
    const d = deps(async () => ({}));

    const res = await handleSnapshot(sm, { session_id: "aa11" }, d);

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.text).toContain('@e1 button "Click"');
    const ax = d.methods.filter((m) => m.startsWith("Accessibility."));
    expect(ax.at(-1)).toBe("Accessibility.disable");
    expect(ax.indexOf("Accessibility.disable")).toBeGreaterThan(
      ax.lastIndexOf("Accessibility.getFullAXTree"),
    );
    expect(ctx.refStore.resolve("e1")).toBe(200);
  });

  it("re-enables accessibility for the next capture after releasing it", async () => {
    const sm = new SessionManager({ agentWindow: agentWindow() });
    await sm.start("aa11");
    const d = deps(async () => ({}));

    await handleSnapshot(sm, { session_id: "aa11" }, d);
    const second = await handleSnapshot(sm, { session_id: "aa11" }, d);

    if ("code" in second) throw new Error(`unexpected error: ${JSON.stringify(second)}`);
    expect(second.text).toContain('@e1 button "Click"');
    const ax = d.methods.filter((m) => m.startsWith("Accessibility."));
    expect(ax.filter((m) => m === "Accessibility.enable")).toHaveLength(2);
    expect(ax.filter((m) => m === "Accessibility.disable")).toHaveLength(2);
  });

  it("still returns the snapshot when releasing accessibility mode fails", async () => {
    const sm = new SessionManager({ agentWindow: agentWindow() });
    const ctx = await sm.start("aa11");
    const d = deps(async () => {
      throw new Error("Accessibility.disable rejected");
    });

    const res = await handleSnapshot(sm, { session_id: "aa11" }, d);

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.text).toContain('@e1 button "Click"');
    expect(ctx.refStore.resolve("e1")).toBe(200);
  });
});
