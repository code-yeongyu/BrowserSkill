const frame = document.createElement("iframe");
frame.id = "foreign-overlay";
frame.title = "Foreign overlay test fixture";
frame.src = `${chrome.runtime.getURL("overlay.html")}?parent=${encodeURIComponent(location.origin)}`;
Object.assign(frame.style, {
  position: "fixed",
  top: "110px",
  left: "16px",
  width: "280px",
  height: "42px",
  zIndex: "100",
});
document.body.append(frame);
