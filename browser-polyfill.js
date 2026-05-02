(() => {
  if (typeof globalThis.browser !== "undefined") {
    globalThis.chrome = globalThis.browser;
  }
})();
