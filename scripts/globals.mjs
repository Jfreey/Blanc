/* 全局名单。三个检查脚本共用一份 —— 各写各的迟早会漂。
 * 覆盖：语言内建 / 基础对象 / 计时器 / 宿主（window、fetch…）/ DOM 构造器 /
 * DOM 事件 / Node 侧的 process、Buffer。
 */
export const GLOBALS = new Set([
  // 语言内建
  "undefined", "NaN", "Infinity", "globalThis", "eval", "isFinite", "isNaN", "parseInt", "parseFloat",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "structuredClone",
  // 基础对象 / 容器
  "Object", "Function", "Boolean", "Symbol", "Error", "EvalError", "RangeError", "ReferenceError",
  "SyntaxError", "TypeError", "URIError", "AggregateError", "Array", "Number", "Date", "String",
  "RegExp", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "BigInt",
  "JSON", "Math", "Promise", "Proxy", "Reflect", "Atomics", "WeakRef", "FinalizationRegistry",
  // 控制台 / 计时
  "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "queueMicrotask",
  // 宿主
  "window", "document", "navigator", "location", "history", "alert", "confirm", "prompt",
  "fetch", "Headers", "Request", "Response", "FormData", "Blob", "File", "FileReader",
  "URL", "URLSearchParams", "URLPattern", "AbortController", "AbortSignal",
  "TextEncoder", "TextDecoder", "crypto", "atob", "btoa", "performance",
  "CustomEvent", "Event", "EventTarget", "MessageChannel", "MessagePort", "BroadcastChannel",
  // DOM 构造器
  "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "HTMLFormElement", "HTMLButtonElement", "HTMLAnchorElement",
  "HTMLImageElement", "HTMLCanvasElement", "HTMLIFrameElement", "HTMLVideoElement",
  "SVGElement", "DocumentFragment", "ShadowRoot", "Text", "Comment", "Range", "Selection",
  "DOMParser", "XMLSerializer", "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "PerformanceObserver", "getComputedStyle", "matchMedia", "requestAnimationFrame",
  "Image", "Audio", "localStorage", "sessionStorage", "getSelection", "scrollTo", "scrollBy",
  "open", "close", "focus", "blur", "print", "find", "structuredClone",
  "CSS", "Intl", "WebAssembly",
  // DOM 事件
  "Event", "CustomEvent", "UIEvent", "MouseEvent", "PointerEvent", "WheelEvent",
  "KeyboardEvent", "InputEvent", "FocusEvent", "CompositionEvent", "DragEvent", "ClipboardEvent",
  "TouchEvent", "AnimationEvent", "TransitionEvent", "ErrorEvent", "PromiseRejectionEvent",
  // 计时器别名 / 其它常见
  "setImmediate", "clearImmediate", "Buffer", "process", "global", "exports", "module",
]);
