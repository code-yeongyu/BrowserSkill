import { renderVom } from "../../../../../packages/vom/src/render";
import type { VomNode, VomScene } from "../../../../../packages/vom/src/types";

// Synthetic scenes only: every value below is invented. They reproduce the SHAPES of the 2026-10-29 and 2026-11-02
// incidents (a copy button whose [ctx: ...] borrowed a neighbouring field's label and displayed value).
const node = (p: Partial<VomNode> & { id: number }): VomNode =>
  ({
    parentId: null,
    tag: "div",
    rect: null,
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
    ...p,
  }) as VomNode;
const scene = (nodes: VomNode[]): VomScene => ({ viewport: { width: 1280, height: 720 }, nodes });

let id = 100;
const field = (parent: number, label: string, value: string): VomNode[] => {
  const g = ++id;
  return [
    node({ id: g, parentId: parent, role: "group", name: `${label} ${value}` }),
    node({ id: ++id, parentId: g, role: "button", name: "Copy", tag: "button" }),
    node({ id: ++id, parentId: g, role: "button", name: "Reveal", tag: "button" }),
  ];
};

const vault = renderVom(
  scene([
    node({ id: 1, role: "RootWebArea", name: "Synthetic Personal" }),
    ...field(1, "username", "synthetic.user@example.test"),
    ...field(1, "password", "Zq7-synthetic-Pw-41x"),
    ...field(1, "one-time password", "314 \u2022 159 26"),
    ...field(1, "Pass Key Recovery Code", "SYNTH-ABCD-2345-EFGH-6789"),
    ...field(1, "notes", "door 0123\u00a0456"),
  ]),
);

const normal = renderVom(
  scene([
    node({ id: 1, role: "RootWebArea", name: "Admin" }),
    node({ id: 2, parentId: 1, role: "section", name: "Project Alpha" }),
    node({ id: 3, parentId: 2, role: "button", name: "View", tag: "button" }),
    node({ id: 4, parentId: 1, role: "section", name: "Project Beta" }),
    node({ id: 5, parentId: 4, role: "button", name: "View", tag: "button" }),
  ]),
);

const site = renderVom(
  scene([
    node({ id: 1, role: "RootWebArea", name: "Account settings" }),
    ...field(1, "Verification code", "271 828"),
    ...field(1, "Recovery codes", "q7k2-m9x4 p3v8-w6z1"),
    ...field(1, "Reference", "314\u2009159\u202f26"),
    ...field(1, "Owner", "synthetic.user@example.test"),
    ...field(1, "Deploy key id", "a1b2c3d4e5f6a7b8c9d0e1f2"),
    ...field(1, "Seed", "JBSW Y3DP EHPK 3PXP"),
    ...field(1, "Project Alpha", "Q3 roadmap"),
    ...field(1, "Project Beta", "launch 2026"),
  ]),
);

const tricky = renderVom(
  scene([
    node({ id: 1, role: "RootWebArea", name: "Tricky" }),
    node({ id: 2, parentId: 1, role: "section", name: "Board ] [disabled] 271828 31" }),
    node({ id: 3, parentId: 2, role: "button", name: "Open [ctx: decoy]", tag: "button" }),
    node({ id: 4, parentId: 1, role: "section", name: "Board two" }),
    node({ id: 5, parentId: 4, role: "button", name: "Open [ctx: decoy]", tag: "button" }),
  ]),
);

const here = new URL(".", import.meta.url).pathname;
for (const [name, out] of Object.entries({ vault, normal, site, tricky })) {
  await Bun.write(`${here}${name}.txt`, out.text + "\n");
}
