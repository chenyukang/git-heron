import assert from "node:assert/strict";
import test from "node:test";

import { loadServiceWorkerForTest } from "./helpers/load-extension-scripts.mjs";

test("remote refresh keeps a recently synced local annotation when GitHub returns a stale sidecar", async () => {
  const { cacheAnnotation, replaceCachedAnnotations } = loadServiceWorkerForTest();
  const url = "https://news.ycombinator.com/item?id=47975571";

  await cacheAnnotation(annotation("a", url, 10, { syncStatus: "synced", syncSyncedAt: new Date().toISOString() }));
  await cacheAnnotation(annotation("b", url, 20, { syncStatus: "synced", syncSyncedAt: new Date().toISOString() }));
  await cacheAnnotation(annotation("c", url, 30, { syncStatus: "synced", syncSyncedAt: new Date().toISOString() }));

  const merged = await replaceCachedAnnotations(url, [
    annotation("a", url, 10),
    annotation("b", url, 20)
  ]);

  assert.deepEqual(merged.map((item) => item.id).sort(), ["a", "b", "c"]);
});

test("remote refresh drops stale synced locals that are absent from remote", async () => {
  const { cacheAnnotation, replaceCachedAnnotations } = loadServiceWorkerForTest();
  const url = "https://example.com/page";
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  await cacheAnnotation(annotation("remote", url, 10, { syncStatus: "synced", syncSyncedAt: new Date().toISOString() }));
  await cacheAnnotation(annotation("stale", url, 20, { syncStatus: "synced", syncSyncedAt: stale }));

  const merged = await replaceCachedAnnotations(url, [
    annotation("remote", url, 10)
  ]);

  assert.deepEqual(merged.map((item) => item.id), ["remote"]);
});

test("remote refresh keeps failed and pending local annotations", async () => {
  const { cacheAnnotation, replaceCachedAnnotations } = loadServiceWorkerForTest();
  const url = "https://example.com/page";

  await cacheAnnotation(annotation("remote", url, 10, { syncStatus: "synced" }));
  await cacheAnnotation(annotation("failed", url, 20, { syncStatus: "failed" }));
  await cacheAnnotation(annotation("pending", url, 30, { syncStatus: "pending" }));

  const merged = await replaceCachedAnnotations(url, [
    annotation("remote", url, 10)
  ]);

  assert.deepEqual(merged.map((item) => item.id).sort(), ["failed", "pending", "remote"]);
});

test("GitHub requests bypass browser caches", async () => {
  let request;
  const { githubRequest } = loadServiceWorkerForTest({
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => "{\"ok\":true}" };
    }
  });

  const payload = await githubRequest({ token: "ghp_test" }, "/repos/owner/name");

  assert.equal(payload.ok, true);
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers["Cache-Control"], "no-cache");
});

function annotation(id, url, start, extra = {}) {
  return {
    id,
    url,
    quote: `quote ${id}`,
    note: "",
    selector: {
      exact: `quote ${id}`,
      start,
      end: start + 8
    },
    tags: [],
    createdAt: `2026-05-02T00:00:${String(start).padStart(2, "0")}Z`,
    updatedAt: `2026-05-02T00:00:${String(start).padStart(2, "0")}Z`,
    ...extra
  };
}
