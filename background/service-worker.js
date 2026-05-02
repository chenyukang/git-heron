const SETTINGS_KEY = "settings";
const DRAFT_PREFIX = "draft:";
const CACHE_PREFIX = "cache:";
const CLIP_SYNCED_PREFIX = "clipSynced:";
const RECENT_TAGS_KEY = "recentTags";
const SYNC_QUEUE_KEY = "syncQueue";
const CLIP_SYNC_QUEUE_KEY = "clipSyncQueue";
const SYNC_TASK_HISTORY_KEY = "syncTaskHistory";
const SYNC_ALARM_NAME = "github-annotator-sync";
const DEFAULT_BRANCH = "main";
const DEFAULT_BASE_PATH = "annotations";
const DEFAULT_CLIP_PATH = "Clippings";
const DEFAULT_SHOW_SELECTION_TOOLBAR = true;
const DEFAULT_ACTIVATION_SHORTCUT = "Ctrl+E";
const DEFAULT_CLIP_SHORTCUT = "Ctrl+O";
const DEFAULT_BACKGROUND_SYNC = true;
const RECENT_LOCAL_SYNC_RETENTION_MS = 10 * 60 * 1000;
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEBUG = true;

let syncQueueRunning = false;
let githubWriteLock = Promise.resolve();

setupExtension();

chrome.runtime.onInstalled.addListener(setupExtension);
chrome.runtime.onStartup?.addListener(setupExtension);
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    syncQueuedWork().catch((error) => debugWarn("syncQueuedWork:alarmFailed", { message: formatError(error) }));
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    updateBadge(tabId, 0);
  }
});
chrome.action.onClicked.addListener(openPagePanelFromAction);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
  return true;
});

async function setupExtension() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chromium builds may not support setAccessLevel for local storage.
  }

  try {
    await chrome.storage.session?.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // storage.session is already restricted to trusted contexts by default.
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  } catch {
    // Badge styling is cosmetic.
  }

  scheduleSyncQueue().catch((error) => debugWarn("setupExtension:scheduleSyncQueueFailed", { message: formatError(error) }));
}

async function openPagePanelFromAction(tab) {
  if (!tab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAGE_PANEL" });
  } catch {
    // Restricted pages or stale content scripts cannot host the in-page panel.
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_SETTINGS":
      return { settings: sanitizeSettings(await getSettings()) };

    case "SAVE_SETTINGS":
      return { settings: await saveSettingsAndNotify(message.settings) };

    case "TEST_GITHUB":
      return { repo: await testGitHub(message.settings) };

    case "CAPTURE_DRAFT":
      return captureDraft(message.draft, sender);

    case "GET_DRAFT":
      return { draft: await getDraft(message.tabId) };

    case "CLEAR_DRAFT":
      await clearDraft(message.tabId);
      return {};

    case "GET_RECENT_TAGS":
      return { tags: await getRecentTags() };

    case "REMEMBER_TAGS":
      return { tags: await rememberRecentTags(message.tags || []) };

    case "CONTENT_READY":
      return contentReady(message.page, sender?.tab?.id);

    case "LIST_CACHED_ANNOTATIONS":
      return { annotations: await getCachedAnnotations(message.url) };

    case "LIST_REMOTE_ANNOTATIONS":
      return listRemoteAnnotationsForTab(message.url, message.title, message.tabId);

    case "SAVE_ANNOTATION":
      return { annotation: await saveAnnotation(message.annotation, message.tabId ?? sender?.tab?.id) };

    case "SAVE_CLIPPING":
      return { clipping: await saveClipping(message.clipping, sender?.tab?.id) };

    case "RETRY_ANNOTATION_SYNC":
      return { annotation: await retryAnnotationSync(message.id, message.url) };

    case "DELETE_LOCAL_ANNOTATION":
      await deleteLocalAnnotation(message.id, message.url);
      return { annotations: await getCachedAnnotations(message.url), tasks: await listSyncTasks() };

    case "RETRY_CLIPPING_SYNC":
      return { clipping: await retryClippingSync(message.id) };

    case "LIST_SYNC_TASKS":
      return { tasks: await listSyncTasks() };

    case "RETRY_SYNC_TASK":
      await retrySyncTask(message.taskType, message.id, message.url);
      return { tasks: await listSyncTasks() };

    case "CANCEL_SYNC_TASK":
      await cancelSyncTask(message.taskType, message.id);
      return { tasks: await listSyncTasks() };

    default:
      throw new Error(`Unknown message type: ${message?.type || "empty"}`);
  }
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return data[SETTINGS_KEY] || {};
}

async function saveSettings(rawSettings = {}) {
  const existing = await getSettings();
  const settings = buildSettings(rawSettings, existing);

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function saveSettingsAndNotify(rawSettings = {}) {
  const settings = sanitizeSettings(await saveSettings(rawSettings));
  await notifySettingsUpdated(settings);
  return settings;
}

async function notifySettingsUpdated(settings) {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(tabs.map((tab) => (
      tab.id == null ? null : chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings })
    )));
  } catch {
    // Settings will be picked up on the next page load.
  }
}

function buildSettings(rawSettings = {}, existing = {}) {
  const repo = parseRepo(rawSettings.repo || existing.repo || "");
  const settings = {
    token: (rawSettings.token ?? existing.token ?? "").trim(),
    repo: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    branch: (rawSettings.branch || existing.branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH,
    basePath: normalizePath(rawSettings.basePath || existing.basePath || DEFAULT_BASE_PATH),
    clipPath: normalizePath(rawSettings.clipPath || existing.clipPath || DEFAULT_CLIP_PATH),
    showSelectionToolbar: rawSettings.showSelectionToolbar ?? existing.showSelectionToolbar ?? DEFAULT_SHOW_SELECTION_TOOLBAR,
    activationShortcut: normalizeShortcut(rawSettings.activationShortcut || existing.activationShortcut || DEFAULT_ACTIVATION_SHORTCUT),
    clipShortcut: normalizeShortcut(rawSettings.clipShortcut || existing.clipShortcut || DEFAULT_CLIP_SHORTCUT),
    backgroundSync: rawSettings.backgroundSync ?? existing.backgroundSync ?? DEFAULT_BACKGROUND_SYNC
  };

  if (!settings.token) {
    throw new Error("GitHub token is required.");
  }
  if (!settings.owner || !settings.name) {
    throw new Error("Repository must be in owner/repo format.");
  }

  return settings;
}

function sanitizeSettings(settings = {}) {
  const hasToken = Boolean(settings.token);
  return {
    repo: settings.repo || "",
    owner: settings.owner || "",
    name: settings.name || "",
    branch: settings.branch || DEFAULT_BRANCH,
    basePath: settings.basePath || DEFAULT_BASE_PATH,
    clipPath: settings.clipPath || DEFAULT_CLIP_PATH,
    showSelectionToolbar: settings.showSelectionToolbar ?? DEFAULT_SHOW_SELECTION_TOOLBAR,
    activationShortcut: settings.activationShortcut || DEFAULT_ACTIVATION_SHORTCUT,
    clipShortcut: settings.clipShortcut || DEFAULT_CLIP_SHORTCUT,
    backgroundSync: settings.backgroundSync ?? DEFAULT_BACKGROUND_SYNC,
    hasToken
  };
}

async function testGitHub(rawSettings) {
  const settings = buildSettings(rawSettings, await getSettings());
  const repo = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}`);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await notifySettingsUpdated(sanitizeSettings(settings));
  return repo;
}

async function getReadySettings() {
  const settings = await getSettings();
  if (!settings.token) {
    throw new Error("Open settings and add a GitHub token first.");
  }
  if (!settings.owner || !settings.name) {
    throw new Error("Open settings and add a repository first.");
  }
  return settings;
}

async function captureDraft(draft, sender) {
  if (!draft?.url || !draft?.selector?.exact) {
    throw new Error("No selection was captured.");
  }

  const tabId = sender?.tab?.id;
  if (tabId == null) {
    throw new Error("Could not identify the current tab.");
  }

  const normalizedDraft = {
    ...draft,
    tabId,
    capturedAt: new Date().toISOString()
  };

  await chrome.storage.session.set({ [`${DRAFT_PREFIX}${tabId}`]: normalizedDraft });
  notifyDraftUpdated(tabId, normalizedDraft);

  return { draft: normalizedDraft };
}

async function getDraft(tabId) {
  if (tabId == null) {
    return null;
  }
  const data = await chrome.storage.session.get(`${DRAFT_PREFIX}${tabId}`);
  return data[`${DRAFT_PREFIX}${tabId}`] || null;
}

async function clearDraft(tabId) {
  if (tabId != null) {
    await chrome.storage.session.remove(`${DRAFT_PREFIX}${tabId}`);
  }
}

async function getRecentTags() {
  const data = await chrome.storage.local.get(RECENT_TAGS_KEY);
  return normalizeTags(Array.isArray(data[RECENT_TAGS_KEY]) ? data[RECENT_TAGS_KEY] : []);
}

async function rememberRecentTags(tags = []) {
  const incoming = normalizeTags(tags);
  if (!incoming.length) {
    return getRecentTags();
  }

  const existing = await getRecentTags();
  const lowerIncoming = new Set(incoming.map((tag) => tag.toLowerCase()));
  const next = incoming
    .concat(existing.filter((tag) => !lowerIncoming.has(tag.toLowerCase())))
    .slice(0, 20);
  await chrome.storage.local.set({ [RECENT_TAGS_KEY]: next });
  return next;
}

async function notifyDraftUpdated(tabId, draft) {
  try {
    await chrome.runtime.sendMessage({ type: "DRAFT_UPDATED", tabId, draft });
  } catch {
    // No side panel is listening yet.
  }
}

async function contentReady(page, tabId) {
  const annotations = await loadPageAnnotationsForContent(page?.url, page?.title, tabId);
  await updatePageBadge(tabId, page?.url, annotations.length);
  return { annotations, settings: sanitizeSettings(await getSettings()) };
}

async function saveAnnotation(input, tabId) {
  const settings = await getReadySettings();
  if (!input?.url || !input?.selector?.exact) {
    throw new Error("Annotation is missing its page URL or quote.");
  }

  const annotation = buildAnnotation(input);

  debugLog("saveAnnotation:start", {
    id: annotation.id,
    url: annotation.url,
    title: annotation.title,
    quoteLength: annotation.quote.length,
    tabId,
    backgroundSync: Boolean(settings.backgroundSync)
  });

  let savedAnnotation = annotation;
  if (settings.backgroundSync) {
    savedAnnotation = markAnnotationSyncState(annotation, "pending");
    await cacheAnnotation(savedAnnotation);
    await queueAnnotationSync(savedAnnotation);
  } else {
    await withGitHubWriteLock(() => upsertMarkdownPage(settings, annotation));
    savedAnnotation = markAnnotationSyncState(annotation, "synced");
    await cacheAnnotation(savedAnnotation);
  }

  await rememberRecentTags(savedAnnotation.tags);
  await clearDraft(tabId);
  await updateBadgeForUrl(tabId, annotation.url);

  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "ANNOTATION_SAVED", annotation: savedAnnotation });
    } catch {
      // The content script may be unavailable on restricted pages.
    }
  }

  return savedAnnotation;
}

async function saveClipping(input = {}, tabId) {
  const settings = await getReadySettings();
  const title = collapseWhitespace(input.title || getUrlHost(input.url) || "Untitled page") || "Untitled page";
  const markdown = String(input.markdown || "").trim();
  if (!input.url || !markdown) {
    throw new Error("Could not extract clipping content from this page.");
  }

  const path = `${settings.clipPath || DEFAULT_CLIP_PATH}/${safeMarkdownFileName(title)}.md`;
  const content = renderClippingMarkdown({
    ...input,
    title,
    markdown
  });
  const clipping = {
    id: input.id || createAnnotationId(),
    url: input.url,
    title,
    path,
    content,
    wordCount: input.wordCount || 0,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  debugLog("saveClipping:start", {
    url: input.url,
    title,
    path,
    markdownLength: markdown.length,
    backgroundSync: Boolean(settings.backgroundSync)
  });

  if (settings.backgroundSync) {
    const queued = markClippingSyncState(clipping, "pending");
    await queueClippingSync(queued);
    return publicClipping(queued);
  }

  await withGitHubWriteLock(() => writeClippingToGitHub(settings, clipping));
  const synced = markClippingSyncState(clipping, "synced");
  await markClippingSynced(synced);
  await updateBadgeForUrl(tabId, synced.url);
  return publicClipping(synced);
}

async function writeClippingToGitHub(settings, clipping) {
  return commitTreeUpdateWithRetry(settings, "Add clipping for link", [
    {
      path: clipping.path,
      mode: "100644",
      type: "blob",
      content: clipping.content
    }
  ]);
}

function buildAnnotation(input) {
  const id = input.id || createAnnotationId();
  return {
    schemaVersion: 1,
    id,
    url: input.url,
    title: input.title || "",
    selector: input.selector,
    quote: input.selector.exact,
    note: input.note || "",
    tags: normalizeTags(input.tags),
    color: input.color || "yellow",
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    client: {
      name: "GitHub Web Annotator",
      version: "0.1.0"
    }
  };
}

async function upsertMarkdownPage(settings, annotation) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await upsertMarkdownPageOnce(settings, annotation, attempt);
    } catch (error) {
      if (!isNonFastForwardError(error) || attempt >= maxAttempts) {
        throw error;
      }

      debugWarn("upsertMarkdownPage:retryNonFastForward", {
        id: annotation.id,
        url: annotation.url,
        attempt,
        maxAttempts,
        message: formatError(error)
      });
      await delay(250 * attempt);
    }
  }

  throw new Error("Could not update GitHub after branch ref changed.");
}

async function upsertMarkdownPageOnce(settings, annotation, attempt) {
  const remoteAnnotation = stripSyncMetadata(annotation);
  const expectedPath = await markdownFilePath(settings, annotation);
  const exactFile = await readMarkdownFile(settings, expectedPath);
  const exactFileMatchesUrl = exactFile && urlMatches(markdownFrontmatterUrl(exactFile.content), annotation.url);
  const existing = exactFileMatchesUrl ? exactFile : await findMarkdownFileByUrl(settings, annotation.url);
  const targetPath = exactFile && !exactFileMatchesUrl
    ? await markdownFilePath(settings, annotation, { includeHash: true })
    : expectedPath;
  const existingAnnotations = await readSidecarAnnotations(settings, annotation.url);
  const annotations = existingAnnotations
    .filter((item) => item.id !== annotation.id)
    .concat(remoteAnnotation);
  const sorted = sortAnnotations(annotations);
  const sidecarPath = await sidecarFilePath(settings, annotation.url);
  debugLog("upsertMarkdownPage:paths", {
    expectedPath,
    targetPath,
    sidecarPath,
    existingPath: existing?.path || null,
    exactFilePath: exactFile?.path || null,
    exactFileMatchesUrl,
    annotationCount: sorted.length,
    attempt
  });
  const sidecarPayload = {
    schemaVersion: 1,
    docType: "github-web-annotator-metadata",
    url: annotation.url,
    updatedAt: new Date().toISOString(),
    annotations: sorted
  };
  const tree = [
    {
      path: targetPath,
      mode: "100644",
      type: "blob",
      content: await renderMarkdownPage(annotation, sorted)
    },
    {
      path: sidecarPath,
      mode: "100644",
      type: "blob",
      content: JSON.stringify(sidecarPayload, null, 2) + "\n"
    }
  ];

  if (existing?.path && existing.path !== targetPath) {
    tree.push({
      path: existing.path,
      mode: "100644",
      type: "blob",
      sha: null
    });
  }

  return commitTreeUpdate(settings, "Add annotation for link", tree);
}

async function queueAnnotationSync(annotation) {
  const queue = await getSyncQueue();
  const existing = queue[annotation.id] || {};
  const now = new Date().toISOString();
  queue[annotation.id] = {
    id: annotation.id,
    url: annotation.url,
    annotation: markAnnotationSyncState(annotation, "pending", {
      attempts: existing.attempts || annotation.syncAttempts || 0
    }),
    status: "pending",
    attempts: existing.attempts || annotation.syncAttempts || 0,
    error: "",
    queuedAt: existing.queuedAt || now,
    updatedAt: now
  };
  await saveSyncQueue(queue);
  await rememberSyncTask(syncTaskFromAnnotationJob(queue[annotation.id]));
  debugLog("queueAnnotationSync", { id: annotation.id, url: annotation.url });
  await scheduleSyncQueue();
  syncQueuedWork().catch((error) => debugWarn("queueAnnotationSync:backgroundFailed", { message: formatError(error) }));
}

async function retryAnnotationSync(id, url) {
  if (!id) {
    throw new Error("Missing annotation id.");
  }

  const queue = await getSyncQueue();
  let job = queue[id];
  let annotation = job?.annotation || null;
  if (!annotation && url) {
    annotation = (await getCachedAnnotations(url)).find((item) => item.id === id) || null;
  }
  if (!annotation) {
    throw new Error("Could not find annotation to retry.");
  }

  const queued = markAnnotationSyncState(annotation, "pending", {
    attempts: job?.attempts || annotation.syncAttempts || 0
  });
  await cacheAnnotation(queued);
  await queueAnnotationSync(queued);
  await notifyAnnotationSyncUpdated(queued);
  return queued;
}

async function deleteLocalAnnotation(id, url) {
  if (!id) {
    throw new Error("Missing annotation id.");
  }

  const queue = await getSyncQueue();
  const job = queue[id];
  const targetUrl = url || job?.annotation?.url || "";
  if (!targetUrl) {
    throw new Error("Missing annotation URL.");
  }

  if (job) {
    delete queue[id];
    await saveSyncQueue(queue);
  }

  await removeCachedAnnotation(targetUrl, id);
  await forgetSyncTask("annotation", id);
  await notifyAnnotationDeleted(id, targetUrl);
  debugLog("deleteLocalAnnotation", { id, url: targetUrl });
}

async function annotationFailureMessage(annotation, error) {
  if (await hasEquivalentSyncedAnnotation(annotation)) {
    return "Duplicate of an existing synced annotation.";
  }
  return formatError(error);
}

async function hasEquivalentSyncedAnnotation(annotation) {
  if (!annotation?.url) {
    return false;
  }

  const cached = await getCachedAnnotations(annotation.url);
  return cached.some((candidate) => (
    candidate?.id !== annotation.id
    && (candidate?.syncStatus || "synced") === "synced"
    && equivalentAnnotation(annotation, candidate)
  ));
}

async function syncQueuedAnnotations() {
  if (syncQueueRunning) {
    debugLog("syncQueuedWork:alreadyRunning");
    return;
  }

  syncQueueRunning = true;
  try {
    await syncQueuedAnnotationsOnce();
    await syncQueuedClippingsOnce();
  } finally {
    syncQueueRunning = false;
  }
}

async function syncQueuedWork() {
  return syncQueuedAnnotations();
}

async function syncQueuedAnnotationsOnce() {
  const queue = await getSyncQueue();
  const jobs = Object.values(queue).filter((job) => job?.id && (job.status === "pending" || job.status === "syncing"));
  if (!jobs.length) {
    return;
  }

  debugLog("syncQueuedAnnotations:start", { count: jobs.length });
  for (const job of jobs) {
    await syncQueueJob(job.id);
  }
}

async function syncQueueJob(id) {
  const settings = await getReadySettings();
  const queue = await getSyncQueue();
  const job = queue[id];
  if (!job?.annotation) {
    return;
  }

  const attempts = (job.attempts || 0) + 1;
  const syncing = markAnnotationSyncState(job.annotation, "syncing", { attempts });
  queue[id] = {
    ...job,
    annotation: syncing,
    status: "syncing",
    attempts,
    error: "",
    updatedAt: new Date().toISOString()
  };
  await saveSyncQueue(queue);
  await cacheAnnotation(syncing);
  await rememberSyncTask(syncTaskFromAnnotationJob(queue[id]));
  await notifyAnnotationSyncUpdated(syncing);

  try {
    await withGitHubWriteLock(() => upsertMarkdownPage(settings, syncing));
    const synced = markAnnotationSyncState(syncing, "synced", { attempts });
    const latestQueue = await getSyncQueue();
    delete latestQueue[id];
    await saveSyncQueue(latestQueue);
    await cacheAnnotation(synced);
    await rememberSyncTask(syncTaskFromAnnotation("annotation", synced, {
      status: "synced",
      attempts,
      queuedAt: job.queuedAt,
      updatedAt: new Date().toISOString()
    }));
    await notifyAnnotationSyncUpdated(synced);
    debugLog("syncQueueJob:synced", { id, url: synced.url, attempts });
  } catch (error) {
    const errorMessage = await annotationFailureMessage(syncing, error);
    const failed = markAnnotationSyncState(syncing, "failed", {
      attempts,
      error: errorMessage
    });
    const latestQueue = await getSyncQueue();
    latestQueue[id] = {
      ...job,
      annotation: failed,
      status: "failed",
      attempts,
      error: errorMessage,
      updatedAt: new Date().toISOString()
    };
    await saveSyncQueue(latestQueue);
    await cacheAnnotation(failed);
    await rememberSyncTask(syncTaskFromAnnotationJob(latestQueue[id]));
    await notifyAnnotationSyncUpdated(failed);
    debugWarn("syncQueueJob:failed", { id, url: failed.url, attempts, error: errorMessage });
  }
}

async function queueClippingSync(clipping) {
  const queue = await getClipSyncQueue();
  const existing = queue[clipping.id] || {};
  const now = new Date().toISOString();
  queue[clipping.id] = {
    id: clipping.id,
    clipping: markClippingSyncState(clipping, "pending", {
      attempts: existing.attempts || clipping.syncAttempts || 0
    }),
    status: "pending",
    attempts: existing.attempts || clipping.syncAttempts || 0,
    error: "",
    queuedAt: existing.queuedAt || now,
    updatedAt: now
  };
  await saveClipSyncQueue(queue);
  await rememberSyncTask(syncTaskFromClippingJob(queue[clipping.id]));
  await notifyClippingSyncUpdated(publicClipping(queue[clipping.id].clipping));
  debugLog("queueClippingSync", { id: clipping.id, path: clipping.path });
  await scheduleSyncQueue();
  syncQueuedWork().catch((error) => debugWarn("queueClippingSync:backgroundFailed", { message: formatError(error) }));
}

async function retryClippingSync(id) {
  if (!id) {
    throw new Error("Missing clipping id.");
  }

  const queue = await getClipSyncQueue();
  const job = queue[id];
  if (!job?.clipping) {
    throw new Error("Could not find clipping to retry.");
  }

  const queued = markClippingSyncState(job.clipping, "pending", {
    attempts: job.attempts || job.clipping.syncAttempts || 0
  });
  await queueClippingSync(queued);
  return publicClipping(queued);
}

async function syncQueuedClippingsOnce() {
  const queue = await getClipSyncQueue();
  const jobs = Object.values(queue).filter((job) => job?.id && (job.status === "pending" || job.status === "syncing"));
  if (!jobs.length) {
    return;
  }

  debugLog("syncQueuedClippings:start", { count: jobs.length });
  for (const job of jobs) {
    await syncClipQueueJob(job.id);
  }
}

async function syncClipQueueJob(id) {
  const settings = await getReadySettings();
  const queue = await getClipSyncQueue();
  const job = queue[id];
  if (!job?.clipping) {
    return;
  }

  const attempts = (job.attempts || 0) + 1;
  const syncing = markClippingSyncState(job.clipping, "syncing", { attempts });
  queue[id] = {
    ...job,
    clipping: syncing,
    status: "syncing",
    attempts,
    error: "",
    updatedAt: new Date().toISOString()
  };
  await saveClipSyncQueue(queue);
  await rememberSyncTask(syncTaskFromClippingJob(queue[id]));
  await notifyClippingSyncUpdated(publicClipping(syncing));

  try {
    await withGitHubWriteLock(() => writeClippingToGitHub(settings, syncing));
    const synced = markClippingSyncState(syncing, "synced", { attempts });
    const latestQueue = await getClipSyncQueue();
    delete latestQueue[id];
    await saveClipSyncQueue(latestQueue);
    await markClippingSynced(synced);
    await rememberSyncTask(syncTaskFromClipping("clipping", synced, {
      status: "synced",
      attempts,
      queuedAt: job.queuedAt,
      updatedAt: new Date().toISOString()
    }));
    await notifyClippingSyncUpdated(publicClipping(synced));
    debugLog("syncClipQueueJob:synced", { id, path: synced.path, attempts });
  } catch (error) {
    const failed = markClippingSyncState(syncing, "failed", {
      attempts,
      error: formatError(error)
    });
    const latestQueue = await getClipSyncQueue();
    latestQueue[id] = {
      ...job,
      clipping: failed,
      status: "failed",
      attempts,
      error: formatError(error),
      updatedAt: new Date().toISOString()
    };
    await saveClipSyncQueue(latestQueue);
    await rememberSyncTask(syncTaskFromClippingJob(latestQueue[id]));
    await notifyClippingSyncUpdated(publicClipping(failed));
    debugWarn("syncClipQueueJob:failed", { id, path: failed.path, attempts, error: formatError(error) });
  }
}

async function getSyncQueue() {
  const data = await chrome.storage.local.get(SYNC_QUEUE_KEY);
  return data[SYNC_QUEUE_KEY] && typeof data[SYNC_QUEUE_KEY] === "object" ? data[SYNC_QUEUE_KEY] : {};
}

async function saveSyncQueue(queue) {
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
}

async function getClipSyncQueue() {
  const data = await chrome.storage.local.get(CLIP_SYNC_QUEUE_KEY);
  return data[CLIP_SYNC_QUEUE_KEY] && typeof data[CLIP_SYNC_QUEUE_KEY] === "object" ? data[CLIP_SYNC_QUEUE_KEY] : {};
}

async function saveClipSyncQueue(queue) {
  await chrome.storage.local.set({ [CLIP_SYNC_QUEUE_KEY]: queue });
}

async function getSyncTaskHistory() {
  const data = await chrome.storage.local.get(SYNC_TASK_HISTORY_KEY);
  return Array.isArray(data[SYNC_TASK_HISTORY_KEY]) ? data[SYNC_TASK_HISTORY_KEY] : [];
}

async function saveSyncTaskHistory(tasks) {
  await chrome.storage.local.set({ [SYNC_TASK_HISTORY_KEY]: tasks.slice(0, 5) });
}

async function rememberSyncTask(task) {
  if (!task?.id || !task?.type) {
    return;
  }

  const normalized = normalizeSyncTask(task);
  const history = await getSyncTaskHistory();
  const next = [
    normalized,
    ...history.filter((item) => syncTaskKey(item) !== syncTaskKey(normalized))
  ].slice(0, 5);
  await saveSyncTaskHistory(next);
  notifySyncTasksUpdated().catch((error) => debugWarn("rememberSyncTask:notifyFailed", { message: formatError(error) }));
}

async function forgetSyncTask(type, id) {
  if (!type || !id) {
    return;
  }

  const key = syncTaskKey({ type, id });
  const history = await getSyncTaskHistory();
  await saveSyncTaskHistory(history.filter((item) => syncTaskKey(item) !== key));
  notifySyncTasksUpdated().catch((error) => debugWarn("forgetSyncTask:notifyFailed", { message: formatError(error) }));
}

async function listSyncTasks() {
  const [annotationQueue, clipQueue, history] = await Promise.all([
    getSyncQueue(),
    getClipSyncQueue(),
    getSyncTaskHistory()
  ]);
  const byKey = new Map(history.map((task) => [syncTaskKey(task), normalizeSyncTask(task)]));

  for (const job of Object.values(annotationQueue)) {
    const task = syncTaskFromAnnotationJob(job);
    if (task) {
      byKey.set(syncTaskKey(task), task);
    }
  }

  for (const job of Object.values(clipQueue)) {
    const task = syncTaskFromClippingJob(job);
    if (task) {
      byKey.set(syncTaskKey(task), task);
    }
  }

  return [...byKey.values()]
    .filter((task) => task.id && task.type)
    .sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""))
    .slice(0, 5);
}

async function retrySyncTask(type, id, url) {
  if (type === "annotation") {
    await retryAnnotationSync(id, url);
    return;
  }
  if (type === "clipping") {
    await retryClippingSync(id);
    return;
  }
  throw new Error("Unknown sync task type.");
}

async function cancelSyncTask(type, id) {
  if (!id) {
    throw new Error("Missing sync task id.");
  }

  if (type === "annotation") {
    const queue = await getSyncQueue();
    const job = queue[id];
    if (!job?.annotation) {
      throw new Error("Could not find annotation sync task.");
    }

    delete queue[id];
    await saveSyncQueue(queue);
    const canceled = markAnnotationSyncState(job.annotation, "canceled", { attempts: job.attempts || 0 });
    await cacheAnnotation(canceled);
    await rememberSyncTask(syncTaskFromAnnotation("annotation", canceled, {
      status: "canceled",
      attempts: job.attempts || 0,
      queuedAt: job.queuedAt,
      updatedAt: new Date().toISOString()
    }));
    await notifyAnnotationSyncUpdated(canceled);
    debugLog("cancelSyncTask:annotation", { id });
    return;
  }

  if (type === "clipping") {
    const queue = await getClipSyncQueue();
    const job = queue[id];
    if (!job?.clipping) {
      throw new Error("Could not find clipping sync task.");
    }

    delete queue[id];
    await saveClipSyncQueue(queue);
    const canceled = markClippingSyncState(job.clipping, "canceled", { attempts: job.attempts || 0 });
    await rememberSyncTask(syncTaskFromClipping("clipping", canceled, {
      status: "canceled",
      attempts: job.attempts || 0,
      queuedAt: job.queuedAt,
      updatedAt: new Date().toISOString()
    }));
    await notifyClippingSyncUpdated(publicClipping(canceled));
    debugLog("cancelSyncTask:clipping", { id });
    return;
  }

  throw new Error("Unknown sync task type.");
}

async function scheduleSyncQueue() {
  const annotationQueue = await getSyncQueue();
  const clipQueue = await getClipSyncQueue();
  const hasAnnotationWork = Object.values(annotationQueue).some((job) => job?.status === "pending" || job?.status === "syncing");
  const hasClipWork = Object.values(clipQueue).some((job) => job?.status === "pending" || job?.status === "syncing");
  const hasWork = hasAnnotationWork || hasClipWork;
  if (!hasWork) {
    return;
  }

  try {
    await chrome.alarms?.create(SYNC_ALARM_NAME, { delayInMinutes: 0.1 });
  } catch (error) {
    debugWarn("scheduleSyncQueue:failed", { message: formatError(error) });
  }
}

async function withGitHubWriteLock(callback) {
  const previous = githubWriteLock;
  let release;
  githubWriteLock = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
  }
}

async function listRemoteAnnotations(url, title = "") {
  if (!url) {
    return [];
  }

  const settings = await getReadySettings();
  const cached = await getCachedAnnotations(url);
  debugLog("listRemoteAnnotations:start", {
    url,
    title,
    branch: settings.branch,
    basePath: settings.basePath,
    cachedCount: cached.length
  });
  const directSidecarAnnotations = await readSidecarAnnotations(settings, url);
  if (directSidecarAnnotations.length) {
    debugLog("listRemoteAnnotations:directSidecarHit", {
      url,
      count: directSidecarAnnotations.length
    });
    return replaceCachedAnnotations(url, directSidecarAnnotations);
  }

  const expectedPath = await markdownFilePath(settings, { url, title });
  const exactFile = await readMarkdownFile(settings, expectedPath);
  const file = exactFile && urlMatches(markdownFrontmatterUrl(exactFile.content), url)
    ? exactFile
    : await findMarkdownFileByUrl(settings, url);

  if (!file) {
    debugLog("listRemoteAnnotations:noMarkdownFile", { url, expectedPath });
    return replaceCachedAnnotations(url, []);
  }

  const annotations = await readSidecarAnnotationsForMarkdown(settings, file);
  debugLog("listRemoteAnnotations:markdownSidecar", {
    markdownPath: file.path,
    count: annotations.length
  });
  if (!annotations.length && cached.length) {
    debugLog("listRemoteAnnotations:usingCachedFallback", {
      cachedCount: cached.length
    });
    return cached;
  }
  return replaceCachedAnnotations(url, annotations);
}

async function listRemoteAnnotationsForTab(url, title, tabId) {
  const annotations = await listRemoteAnnotations(url, title);
  await updatePageBadge(tabId, url, annotations.length);
  return { annotations };
}

async function loadPageAnnotationsForContent(url, title = "", tabId = null) {
  const cached = await getCachedAnnotations(url);

  try {
    const settings = await getSettings();
    if (!settings.token || !settings.owner || !settings.name) {
      return cached;
    }
    if (shouldServeCachedAnnotationsImmediately(cached)) {
      refreshPageAnnotationsInBackground(url, title, tabId);
      return cached;
    }
    return await listRemoteAnnotations(url, title);
  } catch {
    return cached;
  }
}

function shouldServeCachedAnnotationsImmediately(annotations) {
  return (annotations || []).some(shouldServeLocalAnnotationImmediately);
}

function refreshPageAnnotationsInBackground(url, title = "", tabId = null) {
  listRemoteAnnotations(url, title)
    .then(async (annotations) => {
      await updatePageBadge(tabId, url, annotations.length);
      if (tabId != null) {
        await chrome.tabs.sendMessage(tabId, { type: "APPLY_ANNOTATIONS", annotations });
      }
    })
    .catch((error) => debugWarn("refreshPageAnnotationsInBackground:failed", {
      url,
      message: formatError(error)
    }));
}

async function updateBadgeForUrl(tabId, url) {
  if (tabId == null) {
    return;
  }

  const annotations = await getCachedAnnotations(url);
  await updatePageBadge(tabId, url, annotations.length);
}

async function notifyAnnotationSyncUpdated(annotation) {
  try {
    await chrome.runtime.sendMessage({ type: "ANNOTATION_SYNC_UPDATED", annotation });
  } catch {
    // The native side panel may not be open.
  }

  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(tabs.map(async (tab) => {
      if (tab.id == null || !urlMatches(tab.url, annotation.url)) {
        return;
      }
      await updateBadgeForUrl(tab.id, annotation.url);
      await chrome.tabs.sendMessage(tab.id, { type: "ANNOTATION_SYNC_UPDATED", annotation });
    }));
  } catch {
    // Content scripts will pick the status up from cache on the next refresh.
  }
}

async function notifyAnnotationDeleted(id, url) {
  try {
    await chrome.runtime.sendMessage({ type: "ANNOTATION_DELETED", id, url });
  } catch {
    // The native side panel may not be open.
  }

  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(tabs.map(async (tab) => {
      if (tab.id == null || !urlMatches(tab.url, url)) {
        return;
      }
      await updateBadgeForUrl(tab.id, url);
      await chrome.tabs.sendMessage(tab.id, { type: "ANNOTATION_DELETED", id, url });
    }));
  } catch {
    // Content scripts can refresh from cache if the live message is missed.
  }
}

async function notifyClippingSyncUpdated(clipping) {
  try {
    await chrome.runtime.sendMessage({ type: "CLIPPING_SYNC_UPDATED", clipping });
  } catch {
    // The native side panel may not be open.
  }

  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(tabs.map(async (tab) => {
      if (tab.id == null || !urlMatches(tab.url, clipping.url)) {
        return;
      }
      await updateBadgeForUrl(tab.id, clipping.url);
      await chrome.tabs.sendMessage(tab.id, { type: "CLIPPING_SYNC_UPDATED", clipping });
    }));
  } catch {
    // Content scripts will pick the status up on the next clipping action.
  }
}

async function notifySyncTasksUpdated() {
  const tasks = await listSyncTasks();

  try {
    await chrome.runtime.sendMessage({ type: "SYNC_TASKS_UPDATED", tasks });
  } catch {
    // The native side panel may not be open.
  }

  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(tabs.map((tab) => (
      tab.id == null ? null : chrome.tabs.sendMessage(tab.id, { type: "SYNC_TASKS_UPDATED", tasks })
    )));
  } catch {
    // Content scripts can refresh tasks the next time Settings opens.
  }
}

async function updatePageBadge(tabId, url, annotationCount = 0) {
  if (tabId == null) {
    return;
  }

  if (annotationCount > 0) {
    await updateBadge(tabId, annotationCount);
    return;
  }

  await setBadgeText(tabId, await isClippingSynced(url) ? "好" : "");
}

async function updateBadge(tabId, count) {
  if (tabId == null) {
    return;
  }

  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  await setBadgeText(tabId, text);
}

async function setBadgeText(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text: String(text || "") });
  } catch {
    // Some internal pages do not allow per-tab badge updates.
  }
}

async function readMarkdownFile(settings, path) {
  return readRepositoryFile(settings, path);
}

async function readSidecarAnnotations(settings, url) {
  for (const candidate of urlCandidates(url)) {
    const path = await sidecarFilePath(settings, candidate);
    const annotations = await readSidecarAnnotationsAtPath(settings, path);
    if (annotations.length) {
      debugLog("readSidecarAnnotations:hit", {
        candidate,
        path,
        count: annotations.length
      });
      return annotations;
    }
  }

  debugLog("readSidecarAnnotations:miss", {
    url,
    candidates: urlCandidates(url)
  });
  return [];
}

async function readSidecarAnnotationsForMarkdown(settings, markdownFile) {
  const annotationData = markdownFrontmatterValue(markdownFile.content, "annotation_data");
  if (!annotationData) {
    return [];
  }

  const path = normalizeSidecarPath(settings, markdownFile.path, annotationData);
  return readSidecarAnnotationsAtPath(settings, path);
}

async function readSidecarAnnotationsAtPath(settings, path) {
  const file = await readRepositoryFile(settings, path);
  if (!file) {
    debugLog("readSidecarAnnotationsAtPath:notFound", { path });
    return [];
  }

  try {
    const payload = JSON.parse(file.content);
    if (!Array.isArray(payload.annotations)) {
      return [];
    }
    const annotations = sortAnnotations(payload.annotations.filter((item) => item?.id && item?.selector?.exact));
    debugLog("readSidecarAnnotationsAtPath:parsed", {
      path,
      count: annotations.length
    });
    return annotations;
  } catch {
    debugWarn("readSidecarAnnotationsAtPath:parseFailed", { path });
    return [];
  }
}

async function readRepositoryFile(settings, path) {
  try {
    const item = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(settings.branch)}`);
    if (!item?.content) {
      return null;
    }
    return {
      path: item.path || path,
      sha: item.sha,
      content: fromBase64(item.content)
    };
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function findMarkdownFileByUrl(settings, url) {
  let entries;
  try {
    entries = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/contents/${encodeContentPath(settings.basePath)}?ref=${encodeURIComponent(settings.branch)}`);
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }

  if (!Array.isArray(entries)) {
    return null;
  }

  const markdownFiles = entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md"));
  for (const entry of markdownFiles) {
    const file = await readMarkdownFile(settings, entry.path);
    if (file && urlMatches(markdownFrontmatterUrl(file.content), url)) {
      return file;
    }
  }

  return null;
}

async function commitTreeUpdate(settings, message, tree) {
  debugLog("commitTreeUpdate:start", {
    branch: settings.branch,
    entries: tree.map((entry) => ({
      path: entry.path,
      delete: entry.sha === null,
      hasContent: typeof entry.content === "string"
    }))
  });
  const { getRefPath, updateRefPath, ref, branch } = await getWritableBranchRef(settings);
  const parentSha = ref.object?.sha;
  if (!parentSha) {
    throw new Error(`Could not resolve branch ${branch}.`);
  }

  const parent = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/git/commits/${parentSha}`);
  const baseTree = parent.tree?.sha;
  if (!baseTree) {
    throw new Error(`Could not read base tree for ${settings.branch}.`);
  }

  const safeTree = await filterMissingDeletes(settings, baseTree, tree);
  debugLog("commitTreeUpdate:base", {
    branch,
    parentSha,
    baseTree,
    getRefPath,
    updateRefPath,
    safeEntries: safeTree.map((entry) => ({
      path: entry.path,
      delete: entry.sha === null
    }))
  });
  const nextTree = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTree,
      tree: safeTree
    }
  });

  const commit = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/git/commits`, {
    method: "POST",
    body: {
      message,
      tree: nextTree.sha,
      parents: [parentSha]
    }
  });

  await githubRequest(settings, updateRefPath, {
    method: "PATCH",
    body: {
      sha: commit.sha,
      force: false
    }
  });

  debugLog("commitTreeUpdate:done", {
    branch,
    commit: commit.sha,
    tree: nextTree.sha
  });
  return commit;
}

async function commitTreeUpdateWithRetry(settings, message, tree) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await commitTreeUpdate(settings, message, tree);
    } catch (error) {
      if (!isNonFastForwardError(error) || attempt >= maxAttempts) {
        throw error;
      }

      debugWarn("commitTreeUpdateWithRetry:retryNonFastForward", {
        attempt,
        maxAttempts,
        message: formatError(error)
      });
      await delay(250 * attempt);
    }
  }

  throw new Error("Could not update GitHub after branch ref changed.");
}

async function getWritableBranchRef(settings) {
  const getRefPath = branchGetRefPath(settings, settings.branch);

  try {
    return {
      getRefPath,
      updateRefPath: branchUpdateRefPath(settings, settings.branch),
      ref: await githubRequest(settings, getRefPath),
      branch: settings.branch
    };
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  const repo = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}`);
  const defaultBranch = repo.default_branch;
  if (!defaultBranch || defaultBranch === settings.branch) {
    throw new Error(`Branch not found: ${settings.branch}`);
  }

  const fallbackGetRefPath = branchGetRefPath(settings, defaultBranch);
  const fallbackRef = await githubRequest(settings, fallbackGetRefPath);
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      branch: defaultBranch
    }
  });

  return {
    getRefPath: fallbackGetRefPath,
    updateRefPath: branchUpdateRefPath(settings, defaultBranch),
    ref: fallbackRef,
    branch: defaultBranch
  };
}

function branchGetRefPath(settings, branch) {
  return `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/git/ref/heads/${encodeGitRef(branch)}`;
}

function branchUpdateRefPath(settings, branch) {
  return `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/git/refs/heads/${encodeGitRef(branch)}`;
}

async function filterMissingDeletes(settings, baseTree, tree) {
  const deleteEntries = tree.filter((entry) => entry.sha === null);
  if (!deleteEntries.length) {
    return tree;
  }

  const base = await githubRequest(settings, `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.name)}/git/trees/${baseTree}?recursive=1`);
  const existingPaths = new Set((base.tree || []).map((entry) => entry.path));
  const skipped = deleteEntries.filter((entry) => !existingPaths.has(entry.path)).map((entry) => entry.path);
  if (skipped.length) {
    debugWarn("filterMissingDeletes:skippedMissingPaths", { skipped });
  }
  return tree.filter((entry) => entry.sha !== null || existingPaths.has(entry.path));
}

async function renderMarkdownPage(page, annotations) {
  const url = page.url;
  const title = page.title || url;
  const host = getUrlHost(url);
  const now = new Date().toISOString();
  const createdAt = annotations.reduce((oldest, item) => {
    if (!item.createdAt) {
      return oldest;
    }
    return !oldest || item.createdAt < oldest ? item.createdAt : oldest;
  }, "");
  const allTags = uniqueTags(annotations.flatMap((item) => item.tags || []));
  const frontmatter = [
    "---",
    "doc_type: hypothesis-highlights",
    `url: ${yamlString(url)}`,
    `author: ${yamlString(host)}`,
    `site: ${yamlString(host)}`,
    `reference: ${yamlString(url)}`,
    "category: '#article'",
    `source: ${yamlString("github-web-annotator")}`,
    `file_date: ${yamlString(localDateString())}`,
    `annotation_data: ${yamlString(await sidecarFilePathFromUrl(url))}`,
    `page_hash: ${yamlString(await sha256(url))}`,
    `highlight_count: ${annotations.length}`,
    `tags: ${yamlArray(allTags)}`,
    `created_at: ${yamlString(createdAt || now)}`,
    `updated_at: ${yamlString(now)}`,
    "---",
    ""
  ].join("\n");

  return `${frontmatter}
## Metadata
- Author: [${host}]()
- Reference: ${url}
- Category: #article

## Highlights
${annotations.map(renderHighlightMarkdown).join("\n")}
`;
}

function renderHighlightMarkdown(annotation) {
  const quote = collapseWhitespace(annotation.quote || annotation.selector?.exact || "");
  const updatedAt = formatMarkdownDate(annotation.updatedAt || annotation.createdAt);
  const group = "#Notes";
  const note = annotation.note ? `\n  - Note: ${escapeMarkdownInline(collapseWhitespace(annotation.note))}` : "";
  const tags = annotation.tags?.length ? `\n  - Tags: ${annotation.tags.map(formatTag).join(" ")}` : "";

  return `- ${escapeMarkdownInline(quote)} - [Updated on ${updatedAt}](${annotation.url}) - Group: ${group}${note}${tags}`;
}

function renderClippingMarkdown(clipping) {
  const url = clipping.url;
  const title = clipping.title || url;
  const site = clipping.site || clipping.domain || getUrlHost(url);
  const author = clipping.author || site;
  const clippedAt = new Date().toISOString();
  const frontmatter = [
    "---",
    "doc_type: web-clipping",
    `url: ${yamlString(url)}`,
    `title: ${yamlString(title)}`,
    `author: ${yamlString(author)}`,
    `site: ${yamlString(site)}`,
    clipping.published ? `published: ${yamlString(clipping.published)}` : "",
    `clipped_at: ${yamlString(clippedAt)}`,
    `source: ${yamlString("github-web-annotator")}`,
    "---",
    ""
  ].filter((line) => line !== "").join("\n");

  return `${frontmatter}
# ${title}

${clipping.markdown.trim()}
`;
}

function markdownFrontmatterUrl(markdown) {
  return markdownFrontmatterValue(markdown, "url");
}

function markdownFrontmatterValue(markdown, key) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return "";
  }

  const line = match[1].split("\n").find((item) => item.trim().startsWith(`${key}:`));
  if (!line) {
    return "";
  }

  return parseYamlString(line.replace(new RegExp(`^${key}:\\s*`), ""));
}

async function cacheAnnotation(annotation) {
  const key = await cacheKey(annotation.url);
  const data = await chrome.storage.local.get(key);
  const annotations = Array.isArray(data[key]) ? data[key] : [];
  const next = annotations.filter((item) => item.id !== annotation.id).concat(annotation);
  await chrome.storage.local.set({ [key]: sortAnnotations(next) });
}

async function removeCachedAnnotation(url, id) {
  const key = await cacheKey(url);
  const data = await chrome.storage.local.get(key);
  const annotations = Array.isArray(data[key]) ? data[key] : [];
  const next = annotations.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [key]: sortAnnotations(next) });
  return sortAnnotations(next);
}

async function replaceCachedAnnotations(url, annotations) {
  const key = await cacheKey(url);
  const data = await chrome.storage.local.get(key);
  const existing = Array.isArray(data[key]) ? data[key] : [];
  const remote = annotations.map((annotation) => markAnnotationSyncState(annotation, "synced"));
  const remoteIds = new Set(remote.map((annotation) => annotation.id));
  const retainedLocal = existing.filter((annotation) => (
    annotation.id
    && !remoteIds.has(annotation.id)
    && shouldKeepLocalAnnotationDuringRemoteRefresh(annotation)
  ));
  const merged = sortAnnotations(remote.concat(retainedLocal));
  if (retainedLocal.length) {
    debugLog("replaceCachedAnnotations:retainedLocal", {
      url,
      remoteCount: remote.length,
      existingCount: existing.length,
      retainedCount: retainedLocal.length,
      retainedIds: retainedLocal.map((annotation) => annotation.id)
    });
  }
  await chrome.storage.local.set({ [key]: merged });
  return merged;
}

async function getCachedAnnotations(url) {
  if (!url) {
    return [];
  }
  const key = await cacheKey(url);
  const data = await chrome.storage.local.get(key);
  return sortAnnotations(Array.isArray(data[key]) ? data[key] : []);
}

async function markClippingSynced(clipping) {
  if (!clipping?.url) {
    return;
  }

  const key = await clippingSyncedKey(clipping.url);
  await chrome.storage.local.set({
    [key]: {
      url: canonicalPageUrl(clipping.url),
      title: clipping.title || "",
      path: clipping.path || "",
      syncedAt: clipping.syncSyncedAt || new Date().toISOString()
    }
  });
}

async function isClippingSynced(url) {
  if (!url) {
    return false;
  }

  const key = await clippingSyncedKey(url);
  const data = await chrome.storage.local.get(key);
  return Boolean(data[key]?.syncedAt || data[key] === true);
}

function sortAnnotations(annotations) {
  return annotations.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function markAnnotationSyncState(annotation, status, details = {}) {
  const now = new Date().toISOString();
  return {
    ...annotation,
    syncStatus: status,
    syncError: details.error || "",
    syncAttempts: details.attempts ?? annotation.syncAttempts ?? 0,
    syncUpdatedAt: now,
    syncSyncedAt: status === "synced" ? now : annotation.syncSyncedAt || ""
  };
}

function isUnsyncedAnnotation(annotation) {
  return annotation?.syncStatus === "pending" || annotation?.syncStatus === "syncing" || annotation?.syncStatus === "failed";
}

function shouldKeepLocalAnnotationDuringRemoteRefresh(annotation) {
  if (isUnsyncedAnnotation(annotation)) {
    return true;
  }

  if ((annotation?.syncStatus || "synced") !== "synced") {
    return false;
  }

  const timestamp = Date.parse(annotation.syncSyncedAt || annotation.syncUpdatedAt || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp < RECENT_LOCAL_SYNC_RETENTION_MS;
}

function shouldServeLocalAnnotationImmediately(annotation) {
  if (annotation?.syncStatus === "pending" || annotation?.syncStatus === "syncing") {
    return true;
  }

  if ((annotation?.syncStatus || "synced") !== "synced") {
    return false;
  }

  const timestamp = Date.parse(annotation.syncSyncedAt || annotation.syncUpdatedAt || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp < RECENT_LOCAL_SYNC_RETENTION_MS;
}

function equivalentAnnotation(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftPosition = left?.selector?.start;
  const rightPosition = right?.selector?.start;
  if (
    Number.isFinite(leftPosition)
    && Number.isFinite(rightPosition)
    && Math.abs(leftPosition - rightPosition) > 4
  ) {
    return false;
  }

  return compactAnnotationText(annotationQuote(left)) === compactAnnotationText(annotationQuote(right))
    && normalizeAnnotationText(left.note || "") === normalizeAnnotationText(right.note || "")
    && annotationTagsKey(left) === annotationTagsKey(right);
}

function annotationQuote(annotation) {
  return annotation?.quote || annotation?.selector?.exact || "";
}

function normalizeAnnotationText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactAnnotationText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function annotationTagsKey(annotation) {
  return (annotation?.tags || [])
    .map((tag) => String(tag || "").trim().replace(/^#+/, "").toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

function stripSyncMetadata(annotation) {
  const {
    syncStatus,
    syncError,
    syncAttempts,
    syncUpdatedAt,
    syncSyncedAt,
    ...clean
  } = annotation || {};
  return clean;
}

function markClippingSyncState(clipping, status, details = {}) {
  const now = new Date().toISOString();
  return {
    ...clipping,
    syncStatus: status,
    syncError: details.error || "",
    syncAttempts: details.attempts ?? clipping.syncAttempts ?? 0,
    syncUpdatedAt: now,
    syncSyncedAt: status === "synced" ? now : clipping.syncSyncedAt || ""
  };
}

function publicClipping(clipping) {
  if (!clipping) {
    return null;
  }
  const {
    content,
    ...publicData
  } = clipping;
  return publicData;
}

function syncTaskFromAnnotationJob(job) {
  if (!job?.id || !job.annotation) {
    return null;
  }

  return syncTaskFromAnnotation("annotation", job.annotation, {
    status: job.status || job.annotation.syncStatus || "pending",
    attempts: job.attempts || job.annotation.syncAttempts || 0,
    error: job.error || job.annotation.syncError || "",
    queuedAt: job.queuedAt || "",
    updatedAt: job.updatedAt || job.annotation.syncUpdatedAt || ""
  });
}

function syncTaskFromAnnotation(type, annotation, details = {}) {
  return normalizeSyncTask({
    id: annotation?.id,
    type,
    status: details.status || annotation?.syncStatus || "synced",
    label: annotation?.note || annotation?.quote || annotation?.selector?.exact || annotation?.title || annotation?.url || "Annotation",
    url: annotation?.url || "",
    attempts: details.attempts ?? annotation?.syncAttempts ?? 0,
    error: details.error || annotation?.syncError || "",
    queuedAt: details.queuedAt || "",
    updatedAt: details.updatedAt || annotation?.syncUpdatedAt || annotation?.updatedAt || annotation?.createdAt || ""
  });
}

function syncTaskFromClippingJob(job) {
  if (!job?.id || !job.clipping) {
    return null;
  }

  return syncTaskFromClipping("clipping", job.clipping, {
    status: job.status || job.clipping.syncStatus || "pending",
    attempts: job.attempts || job.clipping.syncAttempts || 0,
    error: job.error || job.clipping.syncError || "",
    queuedAt: job.queuedAt || "",
    updatedAt: job.updatedAt || job.clipping.syncUpdatedAt || ""
  });
}

function syncTaskFromClipping(type, clipping, details = {}) {
  return normalizeSyncTask({
    id: clipping?.id,
    type,
    status: details.status || clipping?.syncStatus || "synced",
    label: clipping?.title || clipping?.path || clipping?.url || "Clipping",
    url: clipping?.url || "",
    path: clipping?.path || "",
    attempts: details.attempts ?? clipping?.syncAttempts ?? 0,
    error: details.error || clipping?.syncError || "",
    queuedAt: details.queuedAt || "",
    updatedAt: details.updatedAt || clipping?.syncUpdatedAt || clipping?.updatedAt || clipping?.createdAt || ""
  });
}

function normalizeSyncTask(task) {
  const updatedAt = task.updatedAt || new Date().toISOString();
  return {
    id: String(task.id || ""),
    type: task.type === "clipping" ? "clipping" : "annotation",
    status: task.status || "pending",
    label: collapseWhitespace(task.label || (task.type === "clipping" ? "Clipping" : "Annotation")).slice(0, 160),
    url: String(task.url || ""),
    path: String(task.path || ""),
    attempts: task.attempts || 0,
    error: String(task.error || ""),
    queuedAt: task.queuedAt || "",
    updatedAt
  };
}

function syncTaskKey(task) {
  return `${task?.type || "annotation"}:${task?.id || ""}`;
}

async function markdownFilePath(settings, page, options = {}) {
  const date = localDateString();
  const title = safeFileTitle(page.title || getUrlHost(page.url) || "untitled").slice(0, 20) || "untitled";
  const hash = options.includeHash ? `-${(await sha256(page.url)).slice(0, 8)}` : "";
  return `${settings.basePath}/${date}-${title}${hash}.md`;
}

async function sidecarFilePath(settings, url) {
  return `${settings.basePath}/${await sidecarFilePathFromUrl(url)}`;
}

async function sidecarFilePathFromUrl(url) {
  return `.gh-annotator/${await sha256(url)}.json`;
}

function normalizeSidecarPath(settings, markdownPath, annotationDataPath) {
  const clean = String(annotationDataPath || "").replace(/^\/+/, "");
  if (!clean) {
    return "";
  }

  if (clean.startsWith(`${settings.basePath}/`)) {
    return clean;
  }

  if (clean.startsWith(".gh-annotator/")) {
    return `${settings.basePath}/${clean}`;
  }

  const directory = markdownPath.includes("/") ? markdownPath.slice(0, markdownPath.lastIndexOf("/")) : settings.basePath;
  return `${directory}/${clean}`.replace(/\/{2,}/g, "/");
}

async function cacheKey(url) {
  return `${CACHE_PREFIX}${await sha256(url)}`;
}

async function clippingSyncedKey(url) {
  return `${CLIP_SYNCED_PREFIX}${await sha256(canonicalPageUrl(url))}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function githubRequest(settings, path, options = {}) {
  const method = options.method || "GET";
  debugLog("githubRequest:start", { method, path });
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    cache: "no-store",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${settings.token}`,
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.message || `GitHub request failed with ${response.status}.`;
    debugWarn("githubRequest:failed", {
      method,
      path,
      status: response.status,
      message
    });
    const error = new Error(`${message} (${response.status} ${method} ${path})`);
    error.status = response.status;
    error.payload = payload;
    error.path = path;
    error.method = method;
    throw error;
  }

  debugLog("githubRequest:ok", { method, path, status: response.status });
  return payload;
}

function parseRepo(value) {
  const trimmed = String(value || "").trim();
  let match = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) {
    match = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
  }
  if (!match) {
    match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  }

  if (!match) {
    return { owner: "", name: "", fullName: trimmed };
  }

  const owner = match[1];
  const name = match[2].replace(/\.git$/, "");
  return { owner, name, fullName: `${owner}/${name}` };
}

function normalizePath(value) {
  const normalized = String(value || DEFAULT_BASE_PATH)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  return normalized || DEFAULT_BASE_PATH;
}

function normalizeShortcut(value) {
  const raw = String(value || DEFAULT_ACTIVATION_SHORTCUT).trim();
  if (!raw) {
    return DEFAULT_ACTIVATION_SHORTCUT;
  }

  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return DEFAULT_ACTIVATION_SHORTCUT;
  }

  const key = parts.pop();
  const modifiers = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "cmd" || lower === "command" || lower === "meta") {
      return "Meta";
    }
    if (lower === "ctrl" || lower === "control") {
      return "Ctrl";
    }
    if (lower === "alt" || lower === "option") {
      return "Alt";
    }
    if (lower === "shift") {
      return "Shift";
    }
    return part;
  });

  const order = ["Ctrl", "Meta", "Alt", "Shift"];
  const sorted = [...new Set(modifiers)].sort((a, b) => {
    const left = order.indexOf(a);
    const right = order.indexOf(b);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
  return [...sorted, key.length === 1 ? key.toUpperCase() : key].join("+");
}

function safePathSegment(value) {
  return String(value || "page")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

function safeFileTitle(value) {
  return String(value || "untitled")
    .trim()
    .replace(/[\\/:*?"<>|#\[\]\n\r\t]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

function safeMarkdownFileName(value) {
  return String(value || "Untitled page")
    .trim()
    .replace(/[\\/:*?"<>|\n\r\t]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 160)
    .trim() || "Untitled page";
}

function localDateString(date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getUrlHost(url) {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

function urlMatches(left, right) {
  if (!left || !right) {
    return false;
  }

  const rightCandidates = new Set(urlCandidates(right));
  return urlCandidates(left).some((candidate) => rightCandidates.has(candidate));
}

function urlCandidates(url) {
  const candidates = new Set([String(url || "")]);

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    candidates.add(parsed.toString());

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      candidates.add(parsed.toString());
    } else {
      parsed.pathname = `${parsed.pathname}/`.replace(/\/{2,}/g, "/");
      candidates.add(parsed.toString());
    }
  } catch {
    // Keep the original string candidate for non-URL inputs.
  }

  return [...candidates].filter(Boolean);
}

function canonicalPageUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function yamlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function parseYamlString(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function yamlArray(values) {
  if (!values.length) {
    return "[]";
  }
  return `[${values.map(yamlString).join(", ")}]`;
}

function uniqueTags(tags) {
  return [...new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || "").split(",");
  const seen = new Set();
  const normalized = [];

  for (const raw of values) {
    const tag = String(raw || "")
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-");
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(tag);
  }

  return normalized;
}

function formatTag(tag) {
  const clean = String(tag || "").trim();
  return clean.startsWith("#") ? clean : `#${clean}`;
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeMarkdownInline(value) {
  return String(value || "").replace(/\n/g, " ").replace(/\|/g, "\\|");
}

function formatMarkdownDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds())
  ].join("");
}

function encodeContentPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeGitRef(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

function createAnnotationId() {
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  const suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}-${suffix}`;
}

function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value) {
  const clean = String(value).replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatError(error) {
  if (!error) {
    return "Unknown error.";
  }
  if (error.status === 401 && /bad credentials/i.test(error.message || error.payload?.message || "")) {
    return "GitHub token is invalid or expired. Open Settings, paste a fresh token, click Test, then Save.";
  }
  return error.message || String(error);
}

function isNonFastForwardError(error) {
  return error?.status === 422 && /fast forward/i.test(error.message || error.payload?.message || "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(label, details = {}) {
  if (DEBUG) {
    console.info(`[GitHub Annotator BG] ${label}`, details);
  }
}

function debugWarn(label, details = {}) {
  if (DEBUG) {
    console.warn(`[GitHub Annotator BG] ${label}`, details);
  }
}
