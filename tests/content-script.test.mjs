import assert from "node:assert/strict";
import test from "node:test";

import { loadContentScriptForTest } from "./helpers/load-extension-scripts.mjs";

test("stored offset matching tolerates missing DOM whitespace between text nodes", () => {
  const { compactMatchText, findStoredOffsetMatch } = loadContentScriptForTest();
  const exact = [
    "Honestly, Intelligence and Motivation are the most important things to me, not specific competence with a particular technology.",
    "I generally feel like intelligent and motivated people can learn anything."
  ].join("\n");
  const domText = exact.replace("\n", "");
  const fullText = `before ${domText} after`;
  const start = "before ".length;

  const match = findStoredOffsetMatch(fullText, {
    exact,
    start,
    end: start + domText.length
  });

  assert.ok(match);
  assert.equal(compactMatchText(fullText.slice(match.start, match.end)), compactMatchText(exact));
});

test("fallback text matching maps compact whitespace matches back to DOM offsets", () => {
  const { compactMatchText, findBestTextMatch } = loadContentScriptForTest();
  const exact = "one two\nthree";
  const domText = "onetwothree";
  const fullText = `prefix ${domText} suffix`;

  const match = findBestTextMatch(fullText, {
    exact,
    prefix: "prefix ",
    suffix: " suffix"
  });

  assert.ok(match);
  assert.equal(compactMatchText(fullText.slice(match.start, match.end)), compactMatchText(exact));
});

test("panel annotations sort from top to bottom by page position", () => {
  const { compareAnnotationsByPagePosition } = loadContentScriptForTest();
  const annotations = [
    { id: "bottom", selector: { start: 300 }, createdAt: "2026-05-02T00:00:01Z" },
    { id: "top", selector: { start: 20 }, createdAt: "2026-05-02T00:00:03Z" },
    { id: "middle", selector: { start: 120 }, createdAt: "2026-05-02T00:00:02Z" }
  ];

  assert.deepEqual(annotations.sort(compareAnnotationsByPagePosition).map((item) => item.id), [
    "top",
    "middle",
    "bottom"
  ]);
});

test("duplicate annotation comparison ignores whitespace and tag order", () => {
  const { annotationSyncError, equivalentAnnotation } = loadContentScriptForTest();
  const failed = {
    id: "failed",
    note: "Rust 职位",
    quote: "Building a dynamic runtime on top of the Linux BPF\nsub-system.",
    selector: { start: 100 },
    syncStatus: "failed",
    tags: ["Rust", "Hiring"]
  };
  const synced = {
    id: "synced",
    note: "Rust 职位",
    quote: "Building a dynamic runtime on top of the Linux BPF sub-system.",
    selector: { start: 101 },
    syncStatus: "synced",
    tags: ["hiring", "rust"]
  };

  assert.equal(equivalentAnnotation(failed, synced), true);
  assert.equal(annotationSyncError(failed, synced), "Duplicate of an existing synced annotation. Delete this local failed copy.");
});
