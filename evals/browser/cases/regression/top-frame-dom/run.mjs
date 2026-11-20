import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const executable = process.env.BSK_COOP_CHROME;
const port = Number(process.env.BSK_TOP_FRAME_PORT ?? 52929);
const extension = resolve(process.env.BSK_COOP_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const cli = resolve(process.env.BSK_COOP_CLI ?? "target/debug/bsk");
const exec = promisify(execFile);
assert(executable, "Set BSK_COOP_CHROME to a Chrome for Testing executable");
assert(port !== 52800 && Number.isInteger(port));
assert(
  (await readFile(join(extension, "background.js"), "utf8")).includes(`ws://127.0.0.1:${port}`),
);
const chromeVersion = (await exec(executable, ["--version"])).stdout.trim();
assert.match(chromeVersion, /^Google Chrome for Testing /);
console.log(chromeVersion);

const fixture = await readFile(join(directory, "fixture.html"));
const script = await readFile(join(directory, "fixture.js"));
const checkpoints = new Set();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/checkpoint" && req.method === "POST") {
    let receipt = "";
    for await (const chunk of req) receipt += chunk;
    checkpoints.add(receipt);
    res.writeHead(204).end();
  } else if (path === "/fixture.js") {
    res.writeHead(200, { "content-type": "text/javascript" }).end(script);
  } else if (path === "/foreign" || path === "/plain") {
    res
      .writeHead(200, {
        "content-type": "text/html",
        "content-security-policy":
          "default-src 'self'; style-src 'unsafe-inline'; frame-src chrome-extension:; form-action 'none'",
      })
      .end(fixture);
  } else {
    res.writeHead(404).end();
  }
});
const home = await mkdtemp(join(tmpdir(), "bsk-top-frame-"));
const env = { ...process.env, BSK_HOME: home, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const socket = join(home, "run", "daemon.sock");
const command = async (...args) =>
  JSON.parse((await exec(cli, [...args, "--json"], { env, timeout: 32000 })).stdout);
async function rpc(method, params, id = randomUUID()) {
  const stream = connect(socket);
  try {
    stream.setTimeout(35000, () => stream.destroy(new Error(`IPC timeout: ${method}`)));
    await once(stream, "connect");
    stream.write(`${JSON.stringify({ id, method, params })}\n`);
    let partial = "";
    for await (const chunk of stream) {
      partial += chunk;
      const newline = partial.indexOf("\n");
      if (newline >= 0) {
        const reply = JSON.parse(partial.slice(0, newline));
        assert.equal(reply.id, id);
        return reply;
      }
    }
    throw new Error(`No IPC response: ${method}`);
  } finally {
    stream.destroy();
  }
}

async function poll(label, read) {
  const end = Date.now() + 12000;
  do {
    const value = await read();
    if (value) return value;
    await delay(75);
  } while (Date.now() < end);
  throw new Error(`Not ready: ${label}`);
}

function ok(reply) {
  assert(!reply.error, JSON.stringify(reply.error));
  return reply.result;
}

function refused(reply, reason, effect = "none") {
  assert.equal(reply.error?.data?.reason, reason, JSON.stringify(reply));
  assert.equal(reply.error.data.effect_state, effect, JSON.stringify(reply));
}

function ref(result, label) {
  const target = result.observation?.targets?.find((node) => node.label === label);
  assert.match(target?.ref ?? "", /^@e\d+$/u, JSON.stringify(result.observation));
  return target.ref;
}

const fixtureState = ({ note, covered }) => ({
  note: document.getElementById(note)?.value,
  covered: document.getElementById(covered)?.value,
  memo: document.getElementById("memo")?.value,
  activationDisabled: document.getElementById("activate")?.disabled,
  effects: { ...document.getElementById("effects").dataset },
});

let daemon;
let daemonOutput = "";
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream.on("data", (chunk) => {
      daemonOutput = (daemonOutput + chunk).slice(-4000);
    });
  }
  await poll("test daemon", () => command("status").catch(() => false));
  await withChrome(
    {
      executable,
      extensionPath: [extension, join(directory, "driver"), join(directory, "foreign")].join(","),
      deviceScale: 1,
      zoom: 1,
      extraArgs: [
        "--disable-background-networking",
        "--proxy-server=http://127.0.0.1:9",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      ],
    },
    async (send) => {
      await poll("BrowserSkill connection", async () => (await command("browsers")).length);
      let worker;
      for (const target of (await send("Target.getTargets")).targetInfos.filter(
        (entry) => entry.type === "service_worker" && entry.url.endsWith("/worker.js"),
      )) {
        const { sessionId } = await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        const { result } = await send(
          "Runtime.evaluate",
          { expression: "chrome.runtime.getManifest().name", returnByValue: true },
          sessionId,
        );
        if (result.value === "Top-frame test driver") {
          worker = sessionId;
          break;
        }
      }
      assert(worker, "Independent spike driver is not loaded");
      const driverExpression = async (expression) => {
        const evaluation = await send(
          "Runtime.evaluate",
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
          worker,
        );
        assert(!evaluation.exceptionDetails, JSON.stringify(evaluation.exceptionDetails));
        return evaluation.result.value;
      };
      const driver = (fn, ...args) => driverExpression(`(${fn})(...${JSON.stringify(args)})`);
      const readTop = async (tabId, func, args = []) =>
        driverExpression(
          `chrome.scripting.executeScript({
            target: { tabId: ${JSON.stringify(tabId)}, frameIds: [0] },
            world: "ISOLATED", func: (${func}), args: ${JSON.stringify(args)},
          }).then(rows => rows[0].result)`,
        );
      const navigate = async (tabId, path) => {
        const url = `${origin}${path}`;
        await driver(
          async (id, address) => {
            await chrome.tabs.update(id, { url: address });
          },
          tabId,
          url,
        );
        await poll("fixture document", () =>
          readTop(
            tabId,
            (href, foreign) =>
              location.href === href &&
              document.querySelector("#effects") !== null &&
              (!foreign || document.documentElement.dataset.foreignReady === "yes"),
            [url, path.startsWith("/foreign")],
          ).catch(() => false),
        );
      };
      const withSession = async (path, run) => {
        const session = await command("session", "start", "--no-focus");
        try {
          const tabs = await command(
            "tab",
            "list",
            "--session",
            session.session_id,
            "--scope",
            "agent",
          );
          assert.equal(tabs.tabs.length, 1, JSON.stringify(tabs));
          const ids = { session_id: session.session_id, tab_id: tabs.tabs[0].tab_id };
          assert(Number.isInteger(ids.tab_id), JSON.stringify(tabs));
          await navigate(ids.tab_id, path);
          const sync = (opts = {}) =>
            rpc("tool.cooperate", {
              ...ids,
              action: "sync",
              control_policy: "target",
              allow_top_frame_dom: true,
              ...opts,
            });
          const action = (method, context, args = {}, id) =>
            rpc(
              method,
              {
                ...ids,
                context_id: context,
                accept_dom_dispatch: true,
                ...args,
              },
              id,
            );
          const state = () =>
            readTop(ids.tab_id, fixtureState, [{ note: "note", covered: "covered" }]);
          await run({ ids, sync, action, state });
        } finally {
          await command("session", "stop", session.session_id);
        }
      };
      const fill = (action, sync, label = "Note", extra = {}) =>
        action("tool.fill", sync.context_id, { ref: ref(sync, label), value: "sample", ...extra });

      await test("Chrome denies a real foreign-frame attach but allows isolated top injection", () =>
        withSession("/plain", async ({ ids }) => {
          const attach = () =>
            driver(async (tabId) => {
              try {
                await chrome.debugger.attach({ tabId }, "1.3");
              } catch (error) {
                return error.message;
              }
              await chrome.debugger.detach({ tabId });
              return "attached";
            }, ids.tab_id);
          assert.equal(await attach(), "attached");
          await navigate(ids.tab_id, "/foreign");
          assert.match(
            await attach(),
            /Cannot access a chrome-extension:\/\/ URL of different extension/,
          );
          assert.equal(await readTop(ids.tab_id, () => window === window.top), true);
        }));
      await test("opted-in sync reports top scope and supports guarded fill and one activation", () =>
        withSession("/foreign", async ({ sync, action, state }) => {
          const view = ok(await sync());
          assert.equal(view.backend, "top_frame_dom");
          assert.equal(view.frame_scope, "top");
          assert.equal(view.input_trust, "synthetic");
          ok(
            await fill(action, view, "Note", {
              expect: [{ target: ref(view, "Note"), field: "value", equals: "" }],
            }),
          );
          ok(await fill(action, view, "Memo"));
          const changed = await state();
          assert.equal(changed.note, "sample");
          assert.equal(changed.memo, "sample");
          assert.equal(changed.activationDisabled, false);
          assert.equal(changed.effects.inputTrusted, "false");
          assert.equal(changed.effects.changeTrusted, "false");
          ok(await action("tool.click", view.context_id, { ref: ref(view, "Activate") }));
          const effects = (await state()).effects;
          assert.equal(effects.activations, "1");
          assert.equal(effects.childEffects, "0");
        }));
      await test("a top-frame field covered by the foreign iframe is refused without input", () =>
        withSession("/foreign", async ({ sync, action, state }) => {
          const view = ok(await sync());
          refused(await fill(action, view, "Covered"), "target_covered");
          assert.equal((await state()).covered, "");
        }));
      await test("a missing target is not inferred to belong to the foreign frame", () =>
        withSession("/foreign?case=child-only", async ({ sync, action, state }) => {
          const view = ok(await sync());
          const reply = await action("tool.fill", view.context_id, {
            ref: "@e999",
            value: "sample",
          });
          refused(reply, "target_unobservable");
          assert.equal((await state()).effects.childEffects, "0");
        }));
      await test("a controlled field that rejects untrusted input reports unknown, not no effect", () =>
        withSession("/foreign?case=trusted-only", async ({ sync, action, state }) => {
          const view = ok(await sync());
          refused(await fill(action, view), "synthetic_input_unconfirmed", "unknown");
          assert.equal((await state()).note, "");
          assert.equal((await state()).effects.inputs, "1");
        }));
      await test("a new top-frame observation cannot clear an unrelated unknown intent", () =>
        withSession("/foreign?case=trusted-only", async ({ sync, action, ids }) => {
          const view = ok(await sync());
          refused(await fill(action, view), "synthetic_input_unconfirmed", "unknown");
          const ledger = () => command("ledger", "status", "--session", ids.session_id);
          assert.equal((await ledger()).pending_unknown.length, 1);
          ok(await sync());
          assert.equal((await ledger()).pending_unknown.length, 1);
        }));
      await test("the journal fences the context's tab even when another tab became active", () =>
        withSession("/foreign?case=trusted-only", async ({ sync, action, ids }) => {
          const view = ok(await sync());
          const other = await command("tab", "create", "--session", ids.session_id);
          assert.notEqual(other.tab_id, ids.tab_id);
          await navigate(other.tab_id, "/plain");
          ok(await sync({ tab_id: other.tab_id, allow_top_frame_dom: false }));
          refused(
            await fill(action, view, "Note", { tab_id: undefined }),
            "synthetic_input_unconfirmed",
            "unknown",
          );
          const ledger = await command("ledger", "status", "--session", ids.session_id);
          assert.equal(ledger.pending_unknown.length, 1);
          assert.equal(ledger.pending_unknown[0].tab_id, ids.tab_id);
        }));
      await test("document replacement during activation never replays the operation or clears its fence", () =>
        withSession(
          "/foreign?case=navigate-on-activation",
          async ({ sync, action, ids, state }) => {
            const view = ok(await sync());
            ok(await fill(action, view));
            const press = { ref: ref(view, "Activate") };
            const id = randomUUID();
            const first = await action("tool.click", view.context_id, press, id);
            assert.equal(first.error?.data?.effect_state, "unknown", JSON.stringify(first));
            await poll(
              "navigation after fixture activation",
              async () =>
                (await state().catch(() => null))?.effects.crossDocumentActivations === "1",
            );
            const replay = await action("tool.click", view.context_id, press, id);
            assert(replay.error, JSON.stringify(replay));
            assert.equal((await state()).effects.crossDocumentActivations, "1");
            assert.equal(
              (await command("ledger", "status", "--session", ids.session_id)).pending_unknown
                .length,
              1,
            );
          },
        ));
      await test("replacement of an observed element cannot redirect a pending fill", () =>
        withSession("/foreign", async ({ sync, action, state, ids }) => {
          const view = ok(await sync());
          await readTop(ids.tab_id, () => document.getElementById("replace").click());
          refused(await fill(action, view), "stale_target");
          assert.equal((await state()).effects.inputs, "0");
        }));
      await test("a literal guard mismatch and missing mutation opt-in cause zero input", () =>
        withSession("/foreign", async ({ sync, action, state }) => {
          const view = ok(await sync());
          refused(
            await fill(action, view, "Note", {
              expect: [{ target: ref(view, "Note"), field: "value", equals: "not the value" }],
            }),
            "guard_mismatch",
          );
          refused(
            await fill(action, view, "Note", { accept_dom_dispatch: false }),
            "dom_dispatch_opt_in_required",
          );
          assert.equal((await state()).effects.inputs, "0");
        }));
      await test("same-document history changes and same-URL reload retire old authority", () =>
        withSession("/foreign", async ({ sync, action, ids, state }) => {
          const original = ok(await sync());
          await readTop(ids.tab_id, () => history.pushState(null, "", "#history"));
          refused(await fill(action, original), "stale_context");
          const newer = ok(await sync());
          await driver(async (id) => {
            await chrome.tabs.reload(id);
          }, ids.tab_id);
          await poll("reloaded document", () =>
            readTop(
              ids.tab_id,
              () => document.documentElement.dataset.foreignReady === "yes",
            ).catch(() => false),
          );
          refused(await fill(action, newer), "stale_context");
          assert.equal((await state()).effects.inputs, "0");
        }));
      await test("an ordinary CDP tab keeps its existing sync and no-opt-in behavior", () =>
        withSession("/plain", async ({ sync }) => {
          const view = ok(await sync({ allow_top_frame_dom: false }));
          assert.notEqual(view.backend, "top_frame_dom");
          assert(view.context_id);
        }));
      await test("foreign-frame denial does not silently opt an old client into DOM dispatch", () =>
        withSession("/foreign", async ({ sync }) => {
          const reply = await sync({ allow_top_frame_dom: false });
          assert(reply.error, JSON.stringify(reply));
          assert.notEqual(reply.result?.backend, "top_frame_dom");
        }));
      await test("the CLI exposes top-frame opt-in without leaking ctx suffixes", () =>
        withSession("/foreign?case=redaction", async ({ ids, state }) => {
          const view = await command(
            "cooperate",
            "sync",
            "--policy",
            "target",
            "--allow-top-frame-dom",
            "--session",
            ids.session_id,
            "--tab-id",
            String(ids.tab_id),
          );
          assert.equal(view.backend, "top_frame_dom");
          assert(!JSON.stringify(view).includes("private fixture marker"));
          const target = view.observation.targets.find((item) => item.label.startsWith("Note"));
          assert(target);
          await command(
            "fill",
            target.ref,
            "--value",
            "sample",
            "--accept-dom-dispatch",
            "--session",
            ids.session_id,
            "--context",
            view.context_id,
          );
          assert.equal((await state()).note, "sample");
        }));
      await test("trusted input on the top document revokes the previous DOM context", () =>
        withSession("/foreign", async ({ sync, action, state }) => {
          const view = ok(await sync());
          const pages = (await send("Target.getTargets")).targetInfos;
          const page = pages.find(
            (target) => target.type === "page" && target.url === `${origin}/foreign`,
          );
          assert(page, "owned fixture target not found");
          const { sessionId } = await send("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: true,
          });
          try {
            for (const type of ["mousePressed", "mouseReleased"]) {
              await send(
                "Input.dispatchMouseEvent",
                { type, x: 400, y: 360, button: "left", clickCount: 1 },
                sessionId,
              );
            }
          } finally {
            await send("Target.detachFromTarget", { sessionId });
          }
          const reply = await fill(action, view);
          assert.match(reply.error?.data?.reason ?? "", /^(human_intervention|stale_context)$/u);
          assert.equal(reply.error.data.effect_state, "none");
          assert.equal((await state()).effects.inputs, "0");
        }));
      await test("cancellation before renderer authorization has no effect", () =>
        withSession("/foreign", async ({ sync, action, ids, state }) => {
          const view = ok(await sync());
          const id = randomUUID();
          const busy = readTop(ids.tab_id, () => {
            navigator.sendBeacon("/checkpoint", "busy");
            const deadline = performance.now() + 2400;
            while (performance.now() < deadline) {
              // Keep the renderer from reaching the commit gate.
            }
          });
          try {
            await poll("renderer busy", () => checkpoints.has("busy"));
            const pending = action(
              "tool.fill",
              view.context_id,
              { ref: ref(view, "Note"), value: "sample" },
              id,
            );
            await poll(
              "cancel registered operation",
              async () => ok(await rpc("cancel", { rpc_id: id })).cancelled,
            );
            const reply = await pending;
            assert.equal(reply.error?.data?.effect_state, "none", JSON.stringify(reply));
          } finally {
            await busy;
          }
          assert.equal((await state()).effects.inputs, "0");
        }));
      await test("cancellation after activation retains an unknown intent without replay", () =>
        withSession("/foreign?case=pause-on-activation", async ({ sync, action, ids, state }) => {
          const view = ok(await sync());
          ok(await fill(action, view));
          const id = randomUUID();
          const pending = action("tool.click", view.context_id, { ref: ref(view, "Activate") }, id);
          await poll("activation dispatched", () => checkpoints.has("activated"));
          assert.equal(ok(await rpc("cancel", { rpc_id: id })).cancelled, true);
          const reply = await pending;
          assert.equal(reply.error?.data?.effect_state, "unknown", JSON.stringify(reply));
          assert.equal((await state()).effects.activations, "1");
          assert.equal(
            (await command("ledger", "status", "--session", ids.session_id)).pending_unknown.length,
            1,
          );
        }));
      assert.deepEqual(await command("session", "list"), []);
    },
  );
} catch (error) {
  console.error(daemonOutput);
  throw error;
} finally {
  if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
    const closed = once(daemon, "exit");
    daemon.kill();
    await closed;
  }
  server.closeAllConnections();
  server.close();
  await rm(home, { recursive: true, force: true });
}
