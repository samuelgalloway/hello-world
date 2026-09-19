// Runs in every page (isolated world). Two jobs, driven by messages from
// the background service worker:
//   GET_STATE - enumerate visible interactive elements as numbered candidates
//   EXECUTE   - act on a previously-returned candidate id (click/type/scroll/submit)
//
// Element references are kept in `candidateMap`, rebuilt on every GET_STATE
// call. The background/side-panel flow always calls GET_STATE immediately
// before deciding, then EXECUTE with ids from that same call, so ids never
// go stale mid-turn.
(function () {
  if (window.__voiceBrowserContentLoaded) return;
  window.__voiceBrowserContentLoaded = true;

  const MAX_CANDIDATES = 60;
  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    "[onclick]",
    "[tabindex]",
  ].join(", ");

  let candidateMap = new Map();

  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function computeRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "listbox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return null;
  }

  function computeLabel(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ");
      if (text.trim()) return clean(text);
    }

    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && label.innerText.trim()) return clean(label.innerText);
      }
      const parentLabel = el.closest("label");
      if (parentLabel && parentLabel.innerText.trim()) return clean(parentLabel.innerText);
      if (el.placeholder) return clean(el.placeholder);
      if (el.name) return clean(el.name);
      if (el.type) return clean(`${el.type} field`);
    }

    const text = el.innerText || el.textContent || "";
    if (text.trim()) return clean(text);
    if (el.getAttribute("title")) return clean(el.getAttribute("title"));
    if (tag === "img" && el.alt) return clean(el.alt);
    if (tag === "a" && el.href) return clean(el.href);
    return "";
  }

  function getCandidates() {
    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const seen = new Set();
    const items = [];
    for (const el of nodes) {
      if (seen.has(el) || el.disabled) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
      items.push({ el, tag: el.tagName.toLowerCase(), role: computeRole(el), label: computeLabel(el), inViewport, top: rect.top });
    }
    items.sort((a, b) => (a.inViewport === b.inViewport ? a.top - b.top : a.inViewport ? -1 : 1));
    const capped = items.slice(0, MAX_CANDIDATES);

    candidateMap = new Map();
    capped.forEach((item, idx) => candidateMap.set(idx, item.el));
    return capped.map((item, idx) => ({ id: idx, tag: item.tag, role: item.role, label: item.label }));
  }

  function highlight(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "3px solid #6d28d9";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 1200);
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function execute({ action, targetId, value }) {
    const el = targetId !== undefined && targetId !== null ? candidateMap.get(targetId) : null;
    const needsTarget = ["click", "type", "scroll"].includes(action);
    if (needsTarget && !el) {
      return { success: false, message: "Target element no longer found on the page." };
    }

    switch (action) {
      case "click": {
        highlight(el);
        el.click();
        return { success: true, message: `Clicked "${computeLabel(el) || el.tagName.toLowerCase()}".` };
      }
      case "type": {
        highlight(el);
        el.focus();
        if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        } else {
          setNativeValue(el, value);
        }
        return { success: true, message: `Typed "${value}" into "${computeLabel(el) || el.tagName.toLowerCase()}".` };
      }
      case "scroll": {
        highlight(el);
        return { success: true, message: `Scrolled to "${computeLabel(el) || el.tagName.toLowerCase()}".` };
      }
      case "submit": {
        if (el) {
          highlight(el);
          el.click();
          return { success: true, message: `Submitted via "${computeLabel(el) || el.tagName.toLowerCase()}".` };
        }
        const form = document.querySelector("form");
        if (form) {
          if (form.requestSubmit) form.requestSubmit();
          else form.submit();
          return { success: true, message: "Submitted the form." };
        }
        return { success: false, message: "No form found to submit." };
      }
      default:
        return { success: false, message: `Unsupported action "${action}".` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_STATE") {
      sendResponse({ url: location.href, title: document.title, elements: getCandidates() });
      return false;
    }
    if (msg?.type === "EXECUTE") {
      execute(msg).then(sendResponse);
      return true;
    }
    return false;
  });
})();
