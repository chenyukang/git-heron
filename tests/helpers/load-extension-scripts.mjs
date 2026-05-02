import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadContentScriptForTest() {
  const file = path.join(repoRoot, "content", "content-script.js");
  const source = readFileSync(file, "utf8").replace(
    /\n\}\)\(\);\s*$/,
    `
  globalThis.__gitHeronContentTestExports = {
    annotationSyncError,
    compareAnnotationsByPagePosition,
    compactMatchText,
    equivalentAnnotation,
    findBestTextMatch,
    findStoredOffsetMatch,
    normalizeMatchText
  };
})();`
  );

  const context = createBrowserLikeContext();
  vm.runInContext(source, context, { filename: file });
  return context.__gitHeronContentTestExports;
}

export function loadServiceWorkerForTest(options = {}) {
  const file = path.join(repoRoot, "background", "service-worker.js");
  const source = `${readFileSync(file, "utf8")}
globalThis.__gitHeronServiceWorkerTestExports = {
  cacheAnnotation,
  equivalentAnnotation,
  getCachedAnnotations,
  githubRequest,
  markAnnotationSyncState,
  replaceCachedAnnotations,
  shouldKeepLocalAnnotationDuringRemoteRefresh
};`;

  const { chrome, localStore } = createChromeMock();
  const context = vm.createContext({
    URL,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    chrome,
    console: quietConsole(),
    crypto: globalThis.crypto,
    fetch: options.fetch || (async () => ({ ok: true, status: 200, text: async () => "{}" })),
    setTimeout,
    clearTimeout
  });
  context.globalThis = context;

  vm.runInContext(source, context, { filename: file });
  return {
    ...context.__gitHeronServiceWorkerTestExports,
    localStore
  };
}

function createBrowserLikeContext() {
  const windowObject = {
    addEventListener() {},
    clearTimeout,
    getSelection: () => null,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    setTimeout,
    CSS: { escape: (value) => String(value) }
  };

  const context = vm.createContext({
    Node: {
      ELEMENT_NODE: 1,
      TEXT_NODE: 3
    },
    NodeFilter: {
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
      SHOW_TEXT: 4
    },
    chrome: {
      runtime: {
        id: "test-extension",
        onMessage: { addListener() {} },
        sendMessage: async () => ({ ok: true, annotations: [], settings: {} })
      }
    },
    console: quietConsole(),
    document: {
      addEventListener() {},
      body: {},
      documentElement: {}
    },
    setTimeout,
    clearTimeout,
    window: windowObject
  });
  context.globalThis = context;
  return context;
}

function createChromeMock() {
  const localStore = {};
  const event = { addListener() {} };
  const local = storageArea(localStore);

  return {
    localStore,
    chrome: {
      action: {
        onClicked: event,
        setBadgeBackgroundColor: async () => {},
        setBadgeText: async () => {}
      },
      alarms: {
        create: async () => {},
        onAlarm: event
      },
      runtime: {
        id: "test-extension",
        onInstalled: event,
        onMessage: event,
        onStartup: event,
        sendMessage: async () => ({})
      },
      storage: {
        local,
        session: storageArea({})
      },
      tabs: {
        onUpdated: event,
        query: async () => [],
        sendMessage: async () => {}
      }
    }
  };
}

function storageArea(store) {
  return {
    async get(keys) {
      if (typeof keys === "string") {
        return { [keys]: store[keys] };
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store[key]]));
      }

      if (keys && typeof keys === "object") {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, store[key] ?? fallback]));
      }

      return { ...store };
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    },
    async set(values) {
      Object.assign(store, values);
    },
    async setAccessLevel() {}
  };
}

function quietConsole() {
  return {
    error() {},
    info() {},
    log() {},
    warn() {}
  };
}
