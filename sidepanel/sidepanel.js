const state = {
  tabId: null,
  page: null,
  settings: null,
  draft: null,
  annotations: [],
  color: "yellow"
};

const elements = {
  pageTitle: document.querySelector("#page-title"),
  status: document.querySelector("#status"),
  settingsPanel: document.querySelector("#settings-panel"),
  selectionPanel: document.querySelector("#selection-panel"),
  tasksPanel: document.querySelector("#tasks-panel"),
  tasksList: document.querySelector("#tasks-list"),
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsState: document.querySelector("#settings-state"),
  token: document.querySelector("#token"),
  repo: document.querySelector("#repo"),
  branch: document.querySelector("#branch"),
  basePath: document.querySelector("#base-path"),
  clipPath: document.querySelector("#clip-path"),
  showSelectionToolbar: document.querySelector("#show-selection-toolbar"),
  backgroundSync: document.querySelector("#background-sync"),
  activationShortcut: document.querySelector("#activation-shortcut"),
  clipShortcut: document.querySelector("#clip-shortcut"),
  saveSettings: document.querySelector("#save-settings"),
  testSettings: document.querySelector("#test-settings"),
  draftState: document.querySelector("#draft-state"),
  quote: document.querySelector("#quote"),
  note: document.querySelector("#note"),
  tags: document.querySelector("#tags"),
  saveAnnotation: document.querySelector("#save-annotation"),
  sync: document.querySelector("#sync"),
  refresh: document.querySelector("#refresh"),
  list: document.querySelector("#annotation-list")
};

init();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "DRAFT_UPDATED" && message.tabId === state.tabId) {
    state.draft = message.draft;
    renderDraft();
  }

  if (message?.type === "ANNOTATION_SYNC_UPDATED") {
    updateLocalAnnotation(message.annotation);
  }

  if (message?.type === "CLIPPING_SYNC_UPDATED") {
    renderClippingStatus(message.clipping);
  }

  if (message?.type === "SYNC_TASKS_UPDATED" && !elements.settingsPanel.hidden) {
    renderSyncTasks(message.tasks || []);
  }
});

async function init() {
  bindEvents();
  await loadSettings();
  await refreshPageState();
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    setSettingsPanelVisible(elements.settingsPanel.hidden);
  });

  elements.saveSettings.addEventListener("click", saveSettings);
  elements.testSettings.addEventListener("click", testSettings);
  elements.saveAnnotation.addEventListener("click", saveAnnotation);
  elements.note.addEventListener("keydown", handleSubmitShortcut);
  elements.tags.addEventListener("keydown", handleSubmitShortcut);
  elements.sync.addEventListener("click", syncRemoteAnnotations);
  elements.refresh.addEventListener("click", refreshPageState);

  document.querySelectorAll(".swatch").forEach((button) => {
    button.addEventListener("click", () => {
      state.color = button.dataset.color;
      document.querySelectorAll(".swatch").forEach((item) => item.classList.toggle("is-selected", item === button));
    });
  });
}

async function loadSettings() {
  const response = await sendRuntime({ type: "GET_SETTINGS" });
  state.settings = response.settings;
  renderSettings();
}

function renderSettings() {
  elements.repo.value = state.settings?.repo || "";
  elements.branch.value = state.settings?.branch || "main";
  elements.basePath.value = state.settings?.basePath || "annotations";
  elements.clipPath.value = state.settings?.clipPath || "Clippings";
  elements.showSelectionToolbar.checked = state.settings?.showSelectionToolbar ?? true;
  elements.backgroundSync.checked = state.settings?.backgroundSync ?? false;
  elements.activationShortcut.value = state.settings?.activationShortcut || "Ctrl+E";
  elements.clipShortcut.value = state.settings?.clipShortcut || "Ctrl+O";
  elements.token.placeholder = state.settings?.hasToken ? "Saved token" : "github_pat_...";

  const connected = Boolean(state.settings?.hasToken && state.settings?.repo);
  elements.settingsState.textContent = connected ? "Saved" : "Not connected";
  elements.settingsState.classList.toggle("connected", connected);
}

function setSettingsPanelVisible(visible) {
  elements.settingsPanel.hidden = !visible;
  elements.settingsToggle.setAttribute("aria-expanded", String(visible));
  if (visible) {
    refreshSyncTasks();
  }
}

async function refreshPageState() {
  clearStatus();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tab?.id ?? null;

    if (!state.tabId) {
      throw new Error("No active tab was found.");
    }

    state.page = await chrome.tabs.sendMessage(state.tabId, { type: "GET_PAGE_CONTEXT" });
    elements.pageTitle.textContent = state.page.title || state.page.url || "Untitled page";

    const draftResponse = await sendRuntime({ type: "GET_DRAFT", tabId: state.tabId });
    state.draft = draftResponse.draft;
    renderDraft();

    const cached = await sendRuntime({ type: "LIST_CACHED_ANNOTATIONS", url: state.page.url });
    state.annotations = cached.annotations || [];
    renderAnnotations();
    await applyAnnotationsToPage();
  } catch (error) {
    state.page = null;
    state.draft = null;
    state.annotations = [];
    elements.pageTitle.textContent = "Page unavailable";
    renderDraft();
    renderAnnotations();
    showStatus(readableError(error), "error");
  }
}

function renderDraft() {
  const quote = state.draft?.selector?.exact;
  elements.selectionPanel.hidden = !quote;
  elements.quote.textContent = quote || "No selection captured.";
  elements.draftState.textContent = quote ? "Ready" : "Empty";
  elements.draftState.classList.toggle("connected", Boolean(quote));
  elements.saveAnnotation.disabled = !quote;
}

async function saveSettings() {
  clearStatus();
  const token = elements.token.value.trim();
  const payload = {
    repo: elements.repo.value.trim(),
    branch: elements.branch.value.trim() || "main",
    basePath: elements.basePath.value.trim() || "annotations",
    clipPath: elements.clipPath.value.trim() || "Clippings",
    showSelectionToolbar: elements.showSelectionToolbar.checked,
    backgroundSync: elements.backgroundSync.checked,
    activationShortcut: elements.activationShortcut.value.trim() || "Ctrl+E",
    clipShortcut: elements.clipShortcut.value.trim() || "Ctrl+O"
  };
  if (token) {
    payload.token = token;
  }

  try {
    const response = await sendRuntime({ type: "SAVE_SETTINGS", settings: payload });
    state.settings = response.settings;
    elements.token.value = "";
    renderSettings();
    setSettingsPanelVisible(false);
    showStatus("Settings saved.", "success");
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

async function testSettings() {
  clearStatus();
  const token = elements.token.value.trim();
  const payload = {
    repo: elements.repo.value.trim(),
    branch: elements.branch.value.trim() || "main",
    basePath: elements.basePath.value.trim() || "annotations",
    clipPath: elements.clipPath.value.trim() || "Clippings",
    showSelectionToolbar: elements.showSelectionToolbar.checked,
    backgroundSync: elements.backgroundSync.checked,
    activationShortcut: elements.activationShortcut.value.trim() || "Ctrl+E",
    clipShortcut: elements.clipShortcut.value.trim() || "Ctrl+O"
  };
  if (token) {
    payload.token = token;
  }

  try {
    const response = await sendRuntime({ type: "TEST_GITHUB", settings: payload });
    showStatus(`Connected to ${response.repo.full_name}.`, "success");
    await loadSettings();
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

async function saveAnnotation() {
  if (!state.draft) {
    return;
  }

  clearStatus();
  elements.saveAnnotation.disabled = true;

  const annotation = {
    ...state.draft,
    note: elements.note.value.trim(),
    tags: parseTags(elements.tags.value),
    color: state.color
  };

  try {
    const response = await sendRuntime({
      type: "SAVE_ANNOTATION",
      tabId: state.tabId,
      annotation
    });
    state.draft = null;
    elements.note.value = "";
    elements.tags.value = "";
    state.annotations = [response.annotation]
      .concat(state.annotations.filter((item) => item.id !== response.annotation.id));
    renderDraft();
    renderAnnotations();
    await applyAnnotationsToPage();
    showStatus(response.annotation.syncStatus === "synced" ? "Annotation saved to GitHub." : "Queued for GitHub sync.", "success");
  } catch (error) {
    showStatus(readableError(error), "error");
    renderDraft();
  }
}

function handleSubmitShortcut(event) {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !elements.saveAnnotation.disabled) {
    event.preventDefault();
    saveAnnotation();
  }
}

async function syncRemoteAnnotations() {
  if (!state.page?.url) {
    return;
  }

  clearStatus();
  try {
    const response = await sendRuntime({
      type: "LIST_REMOTE_ANNOTATIONS",
      url: state.page.url,
      title: state.page.title,
      tabId: state.tabId
    });
    state.annotations = response.annotations || [];
    renderAnnotations();
    await applyAnnotationsToPage();
    showStatus(`Synced ${state.annotations.length} annotation${state.annotations.length === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

function renderAnnotations() {
  elements.list.textContent = "";

  if (!state.annotations.length) {
    const empty = document.createElement("div");
    empty.className = "annotation-empty";
    empty.textContent = "No annotations for this page.";
    elements.list.append(empty);
    return;
  }

  for (const annotation of state.annotations) {
    elements.list.append(renderAnnotationItem(annotation));
  }
}

function renderAnnotationItem(annotation) {
  const item = document.createElement("article");
  item.className = "annotation-item";

  const quote = document.createElement("div");
  quote.className = "annotation-quote";
  quote.textContent = annotation.quote || annotation.selector?.exact || "";
  item.append(quote);

  if (annotation.note) {
    const note = document.createElement("div");
    note.className = "annotation-note";
    note.textContent = annotation.note;
    item.append(note);
  }

  if (annotation.tags?.length) {
    const tags = document.createElement("div");
    tags.className = "tag-row";
    for (const tag of annotation.tags) {
      const node = document.createElement("span");
      node.className = "tag";
      node.textContent = tag;
      tags.append(node);
    }
    item.append(tags);
  }

  const meta = document.createElement("div");
  meta.className = "annotation-meta";
  meta.textContent = formatDate(annotation.createdAt);
  item.append(meta);

  const sync = document.createElement("div");
  sync.className = "annotation-sync";
  const syncPill = document.createElement("span");
  syncPill.className = "sync-pill";
  syncPill.dataset.status = annotation.syncStatus || "synced";
  syncPill.textContent = syncStatusLabel(annotation.syncStatus);
  sync.append(syncPill);
  if (annotation.syncStatus === "failed" && annotation.syncError) {
    const error = document.createElement("span");
    error.className = "sync-error";
    error.textContent = annotation.syncError;
    sync.append(error);
  }
  item.append(sync);

  const actions = document.createElement("div");
  actions.className = "annotation-actions";

  const focus = document.createElement("button");
  focus.type = "button";
  focus.textContent = "Focus";
  focus.addEventListener("click", () => focusAnnotation(annotation.id));
  actions.append(focus);

  if (annotation.syncStatus === "failed") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => retryAnnotationSync(annotation));
    actions.append(retry);
  }

  item.append(actions);

  return item;
}

async function applyAnnotationsToPage() {
  if (!state.tabId || !state.annotations.length) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(state.tabId, {
      type: "APPLY_ANNOTATIONS",
      annotations: state.annotations
    });
  } catch {
    // Restricted pages do not accept content script messages.
  }
}

async function focusAnnotation(id) {
  try {
    await chrome.tabs.sendMessage(state.tabId, { type: "FOCUS_ANNOTATION", id });
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

async function retryAnnotationSync(annotation) {
  if (!annotation?.id) {
    return;
  }

  showStatus("Retrying sync...");
  try {
    const response = await sendRuntime({
      type: "RETRY_ANNOTATION_SYNC",
      id: annotation.id,
      url: annotation.url || state.page?.url
    });
    updateLocalAnnotation(response.annotation);
    showStatus("Queued for GitHub sync.", "success");
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

async function refreshSyncTasks() {
  try {
    const response = await sendRuntime({ type: "LIST_SYNC_TASKS" });
    renderSyncTasks(response.tasks || []);
  } catch {
    renderSyncTasks([]);
  }
}

function renderSyncTasks(tasks) {
  elements.tasksPanel.hidden = !tasks.length;
  elements.tasksList.textContent = "";
  if (!tasks.length) {
    return;
  }

  for (const task of tasks.slice(0, 5)) {
    elements.tasksList.append(renderTaskItem(task));
  }
}

function renderTaskItem(task) {
  const item = document.createElement("article");
  item.className = "task-item";

  const label = document.createElement("div");
  label.className = "task-label";
  label.textContent = task.label || (task.type === "clipping" ? "Clipping" : "Annotation");
  item.append(label);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.textContent = task.path || task.url || "";
  item.append(meta);

  const sync = document.createElement("div");
  sync.className = "annotation-sync";
  const pill = document.createElement("span");
  pill.className = "sync-pill";
  pill.dataset.status = task.status || "pending";
  pill.textContent = syncStatusLabel(task.status);
  sync.append(pill);
  if (task.status === "failed" && task.error) {
    const error = document.createElement("span");
    error.className = "sync-error";
    error.textContent = task.error;
    sync.append(error);
  }
  item.append(sync);

  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  if (task.status === "failed") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => retrySyncTask(task));
    actions.append(retry);
  }
  if (task.status === "pending" || task.status === "syncing" || task.status === "failed") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelSyncTask(task));
    actions.append(cancel);
  }
  if (actions.childElementCount) {
    item.append(actions);
  }
  return item;
}

async function retrySyncTask(task) {
  showStatus("Retrying task...");
  try {
    const response = await sendRuntime({
      type: "RETRY_SYNC_TASK",
      taskType: task.type,
      id: task.id,
      url: task.url || state.page?.url
    });
    renderSyncTasks(response.tasks || []);
    showStatus("Task queued.", "success");
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

async function cancelSyncTask(task) {
  showStatus("Canceling task...");
  try {
    const response = await sendRuntime({
      type: "CANCEL_SYNC_TASK",
      taskType: task.type,
      id: task.id
    });
    renderSyncTasks(response.tasks || []);
    showStatus("Task canceled.", "success");
  } catch (error) {
    showStatus(readableError(error), "error");
  }
}

function updateLocalAnnotation(annotation) {
  if (!annotation?.id) {
    return;
  }

  state.annotations = [annotation].concat(state.annotations.filter((item) => item.id !== annotation.id));
  renderAnnotations();
  applyAnnotationsToPage();
  if (annotation.syncStatus === "failed") {
    showStatus(`Sync failed: ${annotation.syncError || "Unknown error."}`, "error");
  }
}

function syncStatusLabel(status) {
  if (status === "pending") {
    return "Queued";
  }
  if (status === "syncing") {
    return "Syncing";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "canceled") {
    return "Canceled";
  }
  return "Synced";
}

function renderClippingStatus(clipping) {
  if (!clipping?.id) {
    return;
  }

  if (clipping.syncStatus === "failed") {
    showStatus(`Clipping sync failed: ${clipping.syncError || "Unknown error."}`, "error");
  } else if (clipping.syncStatus === "pending") {
    showStatus(`Queued clipping for GitHub sync: ${clipping.path}.`, "success");
  } else if (clipping.syncStatus === "syncing") {
    showStatus(`Syncing clipping to GitHub: ${clipping.path}.`);
  } else {
    showStatus(`Saved clipping to ${clipping.path}.`, "success");
  }
}

function parseTags(value) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function showStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status visible ${type}`.trim();
}

function clearStatus() {
  elements.status.textContent = "";
  elements.status.className = "status";
}

async function sendRuntime(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Extension request failed.");
  }
  return response;
}

function readableError(error) {
  return error?.message || String(error);
}
