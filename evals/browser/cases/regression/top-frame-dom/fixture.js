const mode = new URL(location.href).searchParams.get("case");
const controls = document.getElementById("controls");
const effects = document.getElementById("effects").dataset;
if (mode === "child-only") controls.remove();
addEventListener("message", (event) => {
  if (
    event.source !== document.getElementById("foreign-overlay")?.contentWindow ||
    !event.origin.startsWith("chrome-extension://")
  ) {
    return;
  }
  if (event.data === "foreign-ready") document.documentElement.dataset.foreignReady = "yes";
  if (event.data === "foreign-acted")
    effects.childEffects = String(Number(effects.childEffects) + 1);
});

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let model = "";
let tracker = "";
function wireNote(note) {
  Object.defineProperty(note, "value", {
    configurable: true,
    get() {
      return nativeValue.get.call(this);
    },
    set(value) {
      nativeValue.set.call(this, value);
      tracker = nativeValue.get.call(this);
    },
  });
  for (const eventName of ["input", "change"]) {
    note.addEventListener(eventName, (event) => {
      effects[eventName === "input" ? "inputTrusted" : "changeTrusted"] = String(event.isTrusted);
      if (eventName === "input") effects.inputs = String(Number(effects.inputs) + 1);
      if ((mode !== "trusted-only" || event.isTrusted) && note.value !== tracker)
        model = note.value;
      queueMicrotask(() => {
        note.value = model;
        document.getElementById("activate").disabled = model.length === 0;
      });
    });
  }
}
if (controls.isConnected) {
  effects.crossDocumentActivations = sessionStorage.getItem("activations") ?? "0";
  wireNote(document.getElementById("note"));
  document.getElementById("activate").addEventListener("click", () => {
    effects.activations = String(Number(effects.activations) + 1);
    if (mode === "navigate-on-activation") {
      sessionStorage.setItem(
        "activations",
        String(Number(sessionStorage.getItem("activations") ?? "0") + 1),
      );
      location.replace("/foreign?case=after-activation");
    }
  });
  document.getElementById("replace").addEventListener("click", () => {
    const note = document.getElementById("note");
    const replacement = note.cloneNode();
    note.replaceWith(replacement);
    wireNote(replacement);
  });
}
