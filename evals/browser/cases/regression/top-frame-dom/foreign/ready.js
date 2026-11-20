const parentOrigin = new URL(location.href).searchParams.get("parent");
document.addEventListener("input", () => parent.postMessage("foreign-acted", parentOrigin));
document.addEventListener("click", () => parent.postMessage("foreign-acted", parentOrigin));
parent.postMessage("foreign-ready", parentOrigin);
