(function () {
  const TOOLBAR_ID = "gh-annotator-toolbar";
  const UI_HOST_ID = "gh-annotator-ui-root";
  const HIGHLIGHT_CLASS = "gh-annotator-highlight";
  const DRAFT_HIGHLIGHT_PREFIX = "gh-annotator-draft-";
  const SKIP_SELECTOR = "script, style, noscript, textarea, input, select, option, [contenteditable='true']";
  const CONTEXT_SIZE = 80;
  const DEBUG = true;
  const DEFAULT_USER_SETTINGS = {
    showSelectionToolbar: true,
    activationShortcut: "Ctrl+E",
    clipShortcut: "Ctrl+O",
    backgroundSync: false
  };

  let toolbar = null;
  let editor = null;
  let detail = null;
  let pagePanel = null;
  let uiRoot = null;
  let pendingDraft = null;
  let editorColor = "yellow";
  let retryObserver = null;
  let retryTimer = null;
  let userSettings = { ...DEFAULT_USER_SETTINGS };
  let userSettingsLoaded = false;
  let currentClipping = null;
  let clippingPanelCloseTimer = null;
  const annotationsById = new Map();

  document.addEventListener("mouseup", handleMouseUp, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("keyup", handleKeyUp, true);
  document.addEventListener("selectionchange", scheduleToolbarHide);
  document.addEventListener("click", handleDocumentClick, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_CONTEXT") {
      sendResponse({ url: location.href, title: document.title });
      return false;
    }

    if (message?.type === "APPLY_ANNOTATIONS") {
      scheduleAnnotationApply(message.annotations || [], { observe: true });
      sendResponse({ applied: true });
      return false;
    }

    if (message?.type === "ANNOTATION_SAVED") {
      applyAnnotations([message.annotation]);
      sendResponse({ applied: true });
      return false;
    }

    if (message?.type === "ANNOTATION_SYNC_UPDATED") {
      updateLocalAnnotation(message.annotation);
      sendResponse({ updated: true });
      return false;
    }

    if (message?.type === "CLIPPING_SYNC_UPDATED") {
      updateClippingStatus(message.clipping);
      sendResponse({ updated: true });
      return false;
    }

    if (message?.type === "SYNC_TASKS_UPDATED") {
      if (pagePanel && !pagePanel.settings.hidden) {
        renderPagePanelTasks(message.tasks || []);
      }
      sendResponse({ updated: true });
      return false;
    }

    if (message?.type === "FOCUS_ANNOTATION") {
      focusAnnotation(message.id);
      sendResponse({ focused: true });
      return false;
    }

    if (message?.type === "TOGGLE_PAGE_PANEL") {
      togglePagePanel()
        .then(() => sendResponse({ toggled: true }))
        .catch((error) => sendResponse({ error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === "SETTINGS_UPDATED") {
      updateUserSettings(message.settings || {});
      sendResponse({ updated: true });
      return false;
    }

    return false;
  });

  announceReady();

  function handleMouseUp(event) {
    if (isAnnotatorUi(event.target)) {
      return;
    }
    captureSelectionSoon();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      hideToolbar();
      return;
    }

    if (isAnnotatorUi(event.target)) {
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    if (shortcutMatches(event, userSettings.clipShortcut)) {
      event.preventDefault();
      event.stopPropagation();
      saveCurrentPageClipping();
      return;
    }

    if (!shortcutMatches(event, userSettings.activationShortcut)) {
      return;
    }

    const draft = buildDraftFromSelection();
    if (!draft) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    pendingDraft = draft;
    activateDraft(draft);
  }

  function handleDocumentClick(event) {
    if (isAnnotatorUi(event.target)) {
      return;
    }

    const mark = event.target?.closest?.(`.${HIGHLIGHT_CLASS}`);
    if (!mark) {
      if (!detail?.root.contains(event.target)) {
        closeDetail();
      }
      return;
    }

    const annotation = annotationsById.get(mark.dataset.ghAnnotationId);
    if (!annotation) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    hideToolbar();
    openAnnotationDetail(annotation);
  }

  function handleKeyUp(event) {
    if (event.key === "Escape") {
      hideToolbar();
      return;
    }
    if (shortcutMatches(event, userSettings.activationShortcut) || editor?.root.hidden === false) {
      return;
    }
    captureSelectionSoon();
  }

  function captureSelectionSoon() {
    window.setTimeout(() => {
      const draft = buildDraftFromSelection();
      if (!draft) {
        hideToolbar();
        return;
      }
      pendingDraft = draft;
      if (shouldShowSelectionToolbar()) {
        showToolbar(draft.rect);
      } else {
        hideToolbar();
      }
    }, 0);
  }

  function scheduleToolbarHide() {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hideToolbar();
      }
    }, 160);
  }

  function buildDraftFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    if (!document.body.contains(range.commonAncestorContainer)) {
      return null;
    }

    const exact = selection.toString().trim();
    if (!exact || exact.length < 2) {
      return null;
    }

    if (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE) {
      const element = range.commonAncestorContainer;
      if (element.closest?.(SKIP_SELECTOR)) {
        return null;
      }
    }

    const selector = createTextSelector(range, exact);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      return null;
    }

    return {
      url: location.href,
      title: document.title,
      selector,
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }
    };
  }

  function createTextSelector(range, exact) {
    const textIndex = buildTextIndex();
    const start = getTextOffset(textIndex, range.startContainer, range.startOffset);
    const end = getTextOffset(textIndex, range.endContainer, range.endOffset);
    const fallbackStart = textIndex.fullText.indexOf(exact);
    const safeStart = start >= 0 ? start : fallbackStart;
    const safeEnd = end >= 0 ? end : safeStart + exact.length;

    return {
      type: "TextQuoteSelector",
      exact,
      prefix: safeStart > 0 ? textIndex.fullText.slice(Math.max(0, safeStart - CONTEXT_SIZE), safeStart) : "",
      suffix: safeEnd >= 0 ? textIndex.fullText.slice(safeEnd, safeEnd + CONTEXT_SIZE) : "",
      start: safeStart,
      end: safeEnd
    };
  }

  function getTextOffset(textIndex, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const item = textIndex.nodes.find((entry) => entry.node === container);
      return item ? item.start + offset : -1;
    }

    if (container.nodeType === Node.ELEMENT_NODE) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, textNodeFilter);
      let childOffset = 0;
      let node = walker.nextNode();
      while (node) {
        const child = node.parentElement;
        if (child && Array.prototype.indexOf.call(container.childNodes, child) >= offset) {
          break;
        }
        const item = textIndex.nodes.find((entry) => entry.node === node);
        if (item) {
          childOffset = item.start;
          break;
        }
        node = walker.nextNode();
      }
      return childOffset;
    }

    return -1;
  }

  function showToolbar(rect) {
    if (!shouldShowSelectionToolbar()) {
      hideToolbar();
      return;
    }

    toolbar = toolbar || createToolbar();
    const top = Math.max(8, rect.top - 42);
    const left = Math.min(window.innerWidth - 48, Math.max(8, rect.left + rect.width / 2 - 20));
    toolbar.style.top = `${top}px`;
    toolbar.style.left = `${left}px`;
    toolbar.hidden = false;
  }

  function hideToolbar() {
    if (toolbar) {
      toolbar.hidden = true;
    }
  }

  function createToolbar() {
    const node = document.createElement("div");
    node.id = TOOLBAR_ID;
    node.className = "gh-annotator-toolbar";
    node.hidden = true;

    const button = document.createElement("button");
    button.type = "button";
    button.title = "Annotate selection";
    button.setAttribute("aria-label", "Annotate selection");
    button.textContent = "✦";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!pendingDraft) {
        return;
      }
      activateDraft(pendingDraft);
    });

    node.append(button);
    appendUiNode(node);
    return node;
  }

  async function activateDraft(draft) {
    let tempHighlightId = "";
    withPreservedScroll(() => {
      hideToolbar();
      tempHighlightId = showDraftHighlight(draft);
      openEditor(draft, { tempHighlightId });
    });
    try {
      await sendRuntimeMessage({ type: "CAPTURE_DRAFT", draft });
    } catch (error) {
      showEditorRuntimeError(error);
    }
  }

  function openEditor(draft, options = {}) {
    editor = editor || createEditor();
    if (editor.tempHighlightId && editor.tempHighlightId !== options.tempHighlightId) {
      clearDraftHighlight(editor.tempHighlightId);
    }
    editor.draft = draft;
    editor.title.textContent = options.mode === "edit" ? "Edit annotation" : "New annotation";
    editor.quote.textContent = draft.selector.exact;
    editor.note.value = options.note || "";
    editor.tags.value = options.tags || "";
    editor.tempHighlightId = options.tempHighlightId || null;
    setEditorStatus("");
    selectEditorColor(options.color || editorColor);
    editor.root.hidden = false;
    focusWithoutScrolling(editor.note);
  }

  function openAnnotationEditor(annotation) {
    if (!annotation?.selector?.exact) {
      return;
    }

    closeDetail();
    openEditor(annotation, {
      mode: "edit",
      note: annotation.note || "",
      tags: (annotation.tags || []).join(", "),
      color: annotation.color || "yellow"
    });
  }

  function closeEditor() {
    if (editor) {
      clearDraftHighlight(editor.tempHighlightId);
      editor.root.hidden = true;
      editor.draft = null;
      editor.tempHighlightId = null;
    }
  }

  function openAnnotationDetail(annotation) {
    detail = detail || createDetail();
    detail.annotation = annotation;
    detail.quote.textContent = annotation.quote || annotation.selector?.exact || "";
    detail.note.textContent = annotation.note || "No note.";
    detail.tags.textContent = "";

    if (annotation.tags?.length) {
      for (const tag of annotation.tags) {
        const node = document.createElement("span");
        node.className = "gh-annotator-detail__tag";
        node.textContent = tag;
        detail.tags.append(node);
      }
    }

    detail.root.hidden = false;
    focusAnnotation(annotation.id, false);
  }

  function closeDetail() {
    if (detail) {
      detail.root.hidden = true;
      detail.annotation = null;
    }
  }

  async function togglePagePanel() {
    pagePanel = pagePanel || createPagePanel();

    if (!pagePanel.root.hidden) {
      pagePanel.root.hidden = true;
      return;
    }

    pagePanel.root.hidden = false;
    await refreshPagePanel();
  }

  async function refreshPagePanel() {
    if (!pagePanel) {
      return;
    }

    setPagePanelStatus("Loading...");
    renderPagePanelAnnotations();

    try {
      const response = await sendRuntimeMessage({ type: "GET_SETTINGS" });
      renderPagePanelSettings(response.settings || {});
      await syncPagePanelAnnotations(false);
      setPagePanelStatus("");
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  function createPagePanel() {
    const root = document.createElement("aside");
    root.className = "gh-annotator-panel";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "GitHub annotations");

    const header = document.createElement("div");
    header.className = "gh-annotator-panel__header";

    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "gh-annotator-panel__title";
    title.textContent = "Annotator";
    const pageTitle = document.createElement("div");
    pageTitle.className = "gh-annotator-panel__page";
    pageTitle.textContent = document.title || location.href;
    titleWrap.append(title, pageTitle);

    const actions = document.createElement("div");
    actions.className = "gh-annotator-panel__header-actions";

    const settingsToggle = panelIconButton("Settings", "⚙");
    const sync = panelIconButton("Sync", "↻");
    const close = panelIconButton("Close", "x");

    settingsToggle.addEventListener("click", togglePagePanelSettings);
    sync.addEventListener("click", () => syncPagePanelAnnotations(true));
    close.addEventListener("click", () => {
      root.hidden = true;
    });

    actions.append(settingsToggle, sync, close);
    header.append(titleWrap, actions);

    const status = document.createElement("div");
    status.className = "gh-annotator-panel__status";

    const clippingActions = document.createElement("div");
    clippingActions.className = "gh-annotator-panel__clip-actions";
    clippingActions.hidden = true;
    const retryClipping = panelButton("Retry clipping");
    retryClipping.addEventListener("click", retryCurrentClippingSync);
    clippingActions.append(retryClipping);

    const settings = createPagePanelSettings();

    const notesHeader = document.createElement("div");
    notesHeader.className = "gh-annotator-panel__section-title";
    notesHeader.textContent = "Page Notes";

    const list = document.createElement("div");
    list.className = "gh-annotator-panel__list";

    root.append(header, status, clippingActions, settings.root, notesHeader, list);
    appendUiNode(root);

    return {
      root,
      status,
      clippingActions,
      retryClipping,
      settings: settings.root,
      settingsState: settings.state,
      token: settings.token,
      repo: settings.repo,
      branch: settings.branch,
      basePath: settings.basePath,
      clipPath: settings.clipPath,
      showSelectionToolbar: settings.showSelectionToolbar,
      backgroundSync: settings.backgroundSync,
      activationShortcut: settings.activationShortcut,
      clipShortcut: settings.clipShortcut,
      tasks: settings.tasks,
      tasksList: settings.tasksList,
      list
    };
  }

  function createPagePanelSettings() {
    const root = document.createElement("section");
    root.className = "gh-annotator-panel__settings";
    root.hidden = true;

    const headingRow = document.createElement("div");
    headingRow.className = "gh-annotator-panel__row";

    const heading = document.createElement("div");
    heading.className = "gh-annotator-panel__section-title";
    heading.textContent = "GitHub";

    const state = document.createElement("span");
    state.className = "gh-annotator-panel__pill";
    headingRow.append(heading, state);

    const token = panelInput("Token", "password", "github_pat_...");
    const repo = panelInput("Repository", "text", "owner/repo");
    const branch = panelInput("Branch", "text", "main");
    const basePath = panelInput("Path", "text", "annotations");
    const clipPath = panelInput("Clip path", "text", "Clippings");
    const showSelectionToolbar = panelCheckbox("Show floating button");
    const backgroundSync = panelCheckbox("Background sync");
    const activationShortcut = panelInput("Shortcut", "text", "Ctrl+E");
    const clipShortcut = panelInput("Clip shortcut", "text", "Ctrl+O");

    const actions = document.createElement("div");
    actions.className = "gh-annotator-panel__actions";
    const save = panelButton("Save", true);
    const test = panelButton("Test");
    save.addEventListener("click", savePagePanelSettings);
    test.addEventListener("click", testPagePanelSettings);
    actions.append(save, test);

    const tasks = document.createElement("section");
    tasks.className = "gh-annotator-panel__tasks";
    tasks.hidden = true;
    const tasksHeading = document.createElement("div");
    tasksHeading.className = "gh-annotator-panel__tasks-heading";
    tasksHeading.textContent = "Tasks";
    const tasksList = document.createElement("div");
    tasksList.className = "gh-annotator-panel__tasks-list";
    tasks.append(tasksHeading, tasksList);

    root.append(headingRow, token.label, repo.label, branch.label, basePath.label, clipPath.label, showSelectionToolbar.label, backgroundSync.label, activationShortcut.label, clipShortcut.label, actions, tasks);

    return {
      root,
      state,
      token: token.input,
      repo: repo.input,
      branch: branch.input,
      basePath: basePath.input,
      clipPath: clipPath.input,
      showSelectionToolbar: showSelectionToolbar.input,
      backgroundSync: backgroundSync.input,
      activationShortcut: activationShortcut.input,
      clipShortcut: clipShortcut.input,
      tasks,
      tasksList
    };
  }

  async function togglePagePanelSettings() {
    const willShow = pagePanel.settings.hidden;
    pagePanel.settings.hidden = !willShow;
    if (willShow) {
      await refreshPagePanelTasks();
    }
  }

  function renderPagePanelSettings(settings) {
    pagePanel.repo.value = settings.repo || "";
    pagePanel.branch.value = settings.branch || "main";
    pagePanel.basePath.value = settings.basePath || "annotations";
    pagePanel.clipPath.value = settings.clipPath || "Clippings";
    pagePanel.showSelectionToolbar.checked = settings.showSelectionToolbar ?? true;
    pagePanel.backgroundSync.checked = settings.backgroundSync ?? false;
    pagePanel.activationShortcut.value = settings.activationShortcut || "Ctrl+E";
    pagePanel.clipShortcut.value = settings.clipShortcut || "Ctrl+O";
    pagePanel.token.placeholder = settings.hasToken ? "Saved token" : "github_pat_...";
    pagePanel.settingsState.textContent = settings.hasToken && settings.repo ? "Saved" : "Not connected";
    pagePanel.settingsState.dataset.connected = String(Boolean(settings.hasToken && settings.repo));
    updateUserSettings(settings);
    if (!settings.hasToken || !settings.repo) {
      pagePanel.settings.hidden = false;
      refreshPagePanelTasks();
    }
  }

  async function savePagePanelSettings() {
    setPagePanelStatus("Saving...");

    try {
      const response = await sendRuntimeMessage({
        type: "SAVE_SETTINGS",
        settings: pagePanelSettingsPayload()
      });
      pagePanel.token.value = "";
      renderPagePanelSettings(response.settings || {});
      pagePanel.settings.hidden = true;
      setPagePanelStatus("Settings saved.", "success");
      await syncPagePanelAnnotations(false);
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  async function testPagePanelSettings() {
    setPagePanelStatus("Testing...");

    try {
      const response = await sendRuntimeMessage({
        type: "TEST_GITHUB",
        settings: pagePanelSettingsPayload()
      });
      pagePanel.token.value = "";
      setPagePanelStatus(`Connected to ${response.repo.full_name}.`, "success");
      const settings = await sendRuntimeMessage({ type: "GET_SETTINGS" });
      renderPagePanelSettings(settings.settings || {});
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  function pagePanelSettingsPayload() {
    const payload = {
      repo: pagePanel.repo.value.trim(),
      branch: pagePanel.branch.value.trim() || "main",
      basePath: pagePanel.basePath.value.trim() || "annotations",
      clipPath: pagePanel.clipPath.value.trim() || "Clippings",
      showSelectionToolbar: pagePanel.showSelectionToolbar.checked,
      backgroundSync: pagePanel.backgroundSync.checked,
      activationShortcut: pagePanel.activationShortcut.value.trim() || "Ctrl+E",
      clipShortcut: pagePanel.clipShortcut.value.trim() || "Ctrl+O"
    };
    const token = pagePanel.token.value.trim();
    if (token) {
      payload.token = token;
    }
    return payload;
  }

  async function syncPagePanelAnnotations(showSuccess) {
    try {
      const response = await sendRuntimeMessage({
        type: "LIST_REMOTE_ANNOTATIONS",
        url: location.href,
        title: document.title
      });
      scheduleAnnotationApply(response.annotations || [], { observe: true });
      renderPagePanelAnnotations();
      if (showSuccess) {
        const count = (response.annotations || []).length;
        setPagePanelStatus(`Synced ${count} annotation${count === 1 ? "" : "s"}.`, "success");
      }
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  async function saveCurrentPageClipping() {
    pagePanel = pagePanel || createPagePanel();
    pagePanel.root.hidden = false;
    setPagePanelStatus("Extracting main content...");

    try {
      const clipping = extractPageClipping();
      setPagePanelStatus("Saving clipping to GitHub...");
      const response = await sendRuntimeMessage({
        type: "SAVE_CLIPPING",
        clipping
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not save clipping.");
      }

      updateClippingStatus(response.clipping);
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  function updateClippingStatus(clipping) {
    if (!clipping?.id) {
      return;
    }

    currentClipping = clipping;
    renderClippingRetryAction();
    if (pagePanel && !pagePanel.settings.hidden) {
      refreshPagePanelTasks();
    }

    if (clipping.syncStatus === "failed") {
      cancelClippingPanelClose();
      setPagePanelStatus(`Clipping sync failed: ${clipping.syncError || "Unknown error."}`, "error");
      return;
    }

    if (clipping.syncStatus === "pending") {
      setPagePanelStatus(`Queued clipping for GitHub sync: ${clipping.path}.`, "success");
      scheduleClippingPanelClose(clipping.id);
      return;
    }

    if (clipping.syncStatus === "syncing") {
      setPagePanelStatus(`Syncing clipping to GitHub: ${clipping.path}.`);
      return;
    }

    setPagePanelStatus(`Saved clipping to ${clipping.path}.`, "success");
    scheduleClippingPanelClose(clipping.id);
  }

  async function retryCurrentClippingSync() {
    if (!currentClipping?.id) {
      return;
    }

    setPagePanelStatus("Retrying clipping sync...");
    try {
      const response = await sendRuntimeMessage({
        type: "RETRY_CLIPPING_SYNC",
        id: currentClipping.id
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not retry clipping sync.");
      }
      updateClippingStatus(response.clipping);
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  function renderClippingRetryAction() {
    if (!pagePanel?.clippingActions) {
      return;
    }
    pagePanel.clippingActions.hidden = currentClipping?.syncStatus !== "failed";
  }

  function scheduleClippingPanelClose(clippingId) {
    cancelClippingPanelClose();
    clippingPanelCloseTimer = window.setTimeout(() => {
      if (!pagePanel || currentClipping?.id !== clippingId || currentClipping?.syncStatus === "failed") {
        return;
      }
      if (!pagePanel.settings.hidden) {
        return;
      }
      pagePanel.root.hidden = true;
    }, 1000);
  }

  function cancelClippingPanelClose() {
    if (clippingPanelCloseTimer) {
      window.clearTimeout(clippingPanelCloseTimer);
      clippingPanelCloseTimer = null;
    }
  }

  async function refreshPagePanelTasks() {
    if (!pagePanel?.tasks) {
      return;
    }

    try {
      const response = await sendRuntimeMessage({ type: "LIST_SYNC_TASKS" });
      renderPagePanelTasks(response.tasks || []);
    } catch (error) {
      renderPagePanelTasks([]);
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  function renderPagePanelTasks(tasks) {
    if (!pagePanel?.tasks || !pagePanel?.tasksList) {
      return;
    }

    pagePanel.tasks.hidden = !tasks.length;
    pagePanel.tasksList.textContent = "";
    if (!tasks.length) {
      return;
    }

    for (const task of tasks.slice(0, 5)) {
      pagePanel.tasksList.append(createPagePanelTask(task));
    }
  }

  function createPagePanelTask(task) {
    const item = document.createElement("article");
    item.className = "gh-annotator-panel__task";

    const main = document.createElement("div");
    main.className = "gh-annotator-panel__task-main";

    const label = document.createElement("div");
    label.className = "gh-annotator-panel__task-label";
    label.textContent = task.label || (task.type === "clipping" ? "Clipping" : "Annotation");

    const meta = document.createElement("div");
    meta.className = "gh-annotator-panel__task-meta";
    meta.textContent = task.path || task.url || "";

    main.append(label, meta);

    const row = document.createElement("div");
    row.className = "gh-annotator-panel__task-row";
    const pill = document.createElement("span");
    pill.className = "gh-annotator-panel__sync-pill";
    pill.dataset.status = task.status || "pending";
    pill.textContent = syncStatusLabel(task.status);
    row.append(pill);

    if (task.status === "failed" && task.error) {
      const error = document.createElement("span");
      error.className = "gh-annotator-panel__sync-error";
      error.textContent = task.error;
      row.append(error);
    }

    const actions = document.createElement("div");
    actions.className = "gh-annotator-panel__task-actions";
    if (task.status === "failed") {
      const retry = panelButton("Retry");
      retry.addEventListener("click", () => retryPagePanelTask(task));
      actions.append(retry);
    }
    if (task.status === "pending" || task.status === "syncing" || task.status === "failed") {
      const cancel = panelButton("Cancel");
      cancel.addEventListener("click", () => cancelPagePanelTask(task));
      actions.append(cancel);
    }

    item.append(main, row);
    if (actions.childElementCount) {
      item.append(actions);
    }
    return item;
  }

  async function retryPagePanelTask(task) {
    setPagePanelStatus("Retrying task...");
    try {
      const response = await sendRuntimeMessage({
        type: "RETRY_SYNC_TASK",
        taskType: task.type,
        id: task.id,
        url: task.url || location.href
      });
      renderPagePanelTasks(response.tasks || []);
      setPagePanelStatus("Task queued.", "success");
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  async function cancelPagePanelTask(task) {
    setPagePanelStatus("Canceling task...");
    try {
      const response = await sendRuntimeMessage({
        type: "CANCEL_SYNC_TASK",
        taskType: task.type,
        id: task.id
      });
      renderPagePanelTasks(response.tasks || []);
      setPagePanelStatus("Task canceled.", "success");
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
    }
  }

  function extractPageClipping() {
    const DefuddleClass = globalThis.Defuddle?.default || globalThis.Defuddle;
    if (!DefuddleClass) {
      throw new Error("Defuddle is not loaded. Reload the extension and refresh this page.");
    }

    const doc = new DOMParser().parseFromString(document.documentElement.outerHTML, "text/html");
    const result = new DefuddleClass(doc, {
      url: location.href,
      markdown: true,
      separateMarkdown: true
    }).parse();
    const markdown = collapseMarkdown(result.contentMarkdown || result.markdown || result.content || "");
    if (!markdown || markdown.length < 20) {
      throw new Error("Defuddle could not find enough main content on this page.");
    }

    return {
      url: location.href,
      title: result.title || document.title || location.href,
      author: result.author || "",
      site: result.site || "",
      domain: result.domain || location.hostname,
      description: result.description || "",
      image: result.image || "",
      favicon: result.favicon || "",
      published: result.published || "",
      language: result.language || document.documentElement.lang || "",
      wordCount: result.wordCount || 0,
      markdown
    };
  }

  function collapseMarkdown(value) {
    return String(value || "")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function renderPagePanelAnnotations() {
    if (!pagePanel) {
      return;
    }

    const annotations = sortedAnnotations();
    pagePanel.list.textContent = "";

    if (!annotations.length) {
      const empty = document.createElement("div");
      empty.className = "gh-annotator-panel__empty";
      empty.textContent = "No annotations for this page.";
      pagePanel.list.append(empty);
      return;
    }

    for (const annotation of annotations) {
      pagePanel.list.append(createPagePanelAnnotation(annotation));
    }
  }

  function createPagePanelAnnotation(annotation) {
    const item = document.createElement("article");
    item.className = "gh-annotator-panel__item";

    const quote = document.createElement("div");
    quote.className = "gh-annotator-panel__quote";
    quote.textContent = annotation.quote || annotation.selector?.exact || "";
    item.append(quote);

    if (annotation.note) {
      const note = document.createElement("div");
      note.className = "gh-annotator-panel__note";
      note.textContent = annotation.note;
      item.append(note);
    }

    if (annotation.tags?.length) {
      const tags = document.createElement("div");
      tags.className = "gh-annotator-panel__tags";
      for (const tag of annotation.tags) {
        const node = document.createElement("span");
        node.className = "gh-annotator-panel__tag";
        node.textContent = tag;
        tags.append(node);
      }
      item.append(tags);
    }

    const sync = document.createElement("div");
    sync.className = "gh-annotator-panel__sync";
    const syncPill = document.createElement("span");
    syncPill.className = "gh-annotator-panel__sync-pill";
    syncPill.dataset.status = annotation.syncStatus || "synced";
    syncPill.textContent = syncStatusLabel(annotation.syncStatus);
    sync.append(syncPill);
    if (annotation.syncStatus === "failed" && annotation.syncError) {
      const error = document.createElement("span");
      error.className = "gh-annotator-panel__sync-error";
      error.textContent = annotation.syncError;
      sync.append(error);
    }
    item.append(sync);

    const itemActions = document.createElement("div");
    itemActions.className = "gh-annotator-panel__item-actions";

    const focus = panelButton("Focus");
    focus.addEventListener("click", () => focusAnnotation(annotation.id));
    const edit = panelButton("Edit");
    edit.addEventListener("click", () => openAnnotationEditor(annotation));

    itemActions.append(focus, edit);
    if (annotation.syncStatus === "failed") {
      const retry = panelButton("Retry");
      retry.addEventListener("click", () => retryAnnotationSync(annotation));
      itemActions.append(retry);
    }
    item.append(itemActions);
    return item;
  }

  function sortedAnnotations() {
    return [...annotationsById.values()].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  function updateLocalAnnotation(annotation) {
    if (!annotation?.id) {
      return;
    }

    annotationsById.set(annotation.id, annotation);
    updateAnnotationMarks(annotation);
    renderPagePanelAnnotations();
    if (annotation.syncStatus === "failed") {
      setPagePanelStatus(`Sync failed: ${annotation.syncError || "Unknown error."}`, "error");
    }
  }

  async function retryAnnotationSync(annotation) {
    if (!annotation?.id) {
      return;
    }

    setPagePanelStatus("Retrying sync...");
    try {
      const response = await sendRuntimeMessage({
        type: "RETRY_ANNOTATION_SYNC",
        id: annotation.id,
        url: annotation.url || location.href
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not retry sync.");
      }
      updateLocalAnnotation(response.annotation);
      setPagePanelStatus("Queued for GitHub sync.", "success");
    } catch (error) {
      setPagePanelStatus(error?.message || String(error), "error");
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

  function setPagePanelStatus(message, kind = "") {
    if (!pagePanel) {
      return;
    }
    pagePanel.status.textContent = message;
    pagePanel.status.dataset.visible = String(Boolean(message));
    if (kind) {
      pagePanel.status.dataset.kind = kind;
    } else {
      delete pagePanel.status.dataset.kind;
    }
  }

  function panelIconButton(title, text) {
    const button = document.createElement("button");
    button.className = "gh-annotator-panel__icon";
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.textContent = text;
    return button;
  }

  function panelButton(text, primary = false) {
    const button = document.createElement("button");
    button.className = "gh-annotator-panel__button";
    button.type = "button";
    button.textContent = text;
    if (primary) {
      button.dataset.primary = "true";
    }
    return button;
  }

  function panelInput(title, type, placeholder) {
    const label = document.createElement("label");
    label.className = "gh-annotator-panel__label";
    label.textContent = title;
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    input.autocomplete = type === "password" ? "new-password" : "off";
    if (type === "password") {
      input.setAttribute("data-1p-ignore", "true");
      input.setAttribute("data-lpignore", "true");
    }
    input.spellcheck = false;
    label.append(input);
    return { label, input };
  }

  function panelCheckbox(title) {
    const label = document.createElement("label");
    label.className = "gh-annotator-panel__checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    const text = document.createElement("span");
    text.textContent = title;
    label.append(input, text);
    return { label, input };
  }

  function createDetail() {
    const root = document.createElement("aside");
    root.className = "gh-annotator-detail";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Annotation note");

    const header = document.createElement("div");
    header.className = "gh-annotator-detail__header";

    const title = document.createElement("div");
    title.className = "gh-annotator-detail__title";
    title.textContent = "Annotation";

    const close = document.createElement("button");
    close.className = "gh-annotator-detail__close";
    close.type = "button";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "x";
    close.addEventListener("click", closeDetail);

    header.append(title, close);

    const body = document.createElement("div");
    body.className = "gh-annotator-detail__body";

    const quote = document.createElement("div");
    quote.className = "gh-annotator-detail__quote";

    const note = document.createElement("div");
    note.className = "gh-annotator-detail__note";

    const tags = document.createElement("div");
    tags.className = "gh-annotator-detail__tags";

    body.append(quote, note, tags);
    root.append(header, body);
    appendUiNode(root);

    return { root, quote, note, tags, annotation: null };
  }

  function createEditor() {
    const root = document.createElement("aside");
    root.className = "gh-annotator-editor";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Annotation editor");

    const header = document.createElement("div");
    header.className = "gh-annotator-editor__header";

    const title = document.createElement("div");
    title.className = "gh-annotator-editor__title";
    title.textContent = "New annotation";

    const close = document.createElement("button");
    close.className = "gh-annotator-editor__close";
    close.type = "button";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "x";
    close.addEventListener("click", closeEditor);

    header.append(title, close);

    const body = document.createElement("div");
    body.className = "gh-annotator-editor__body";

    const quote = document.createElement("div");
    quote.className = "gh-annotator-editor__quote";

    const noteLabel = document.createElement("label");
    noteLabel.textContent = "Note";
    const note = document.createElement("textarea");
    note.rows = 5;
    note.placeholder = "Write a note";
    note.addEventListener("keydown", handleEditorShortcut);
    noteLabel.append(note);

    const tagLabel = document.createElement("label");
    tagLabel.textContent = "Tags";
    const tags = document.createElement("input");
    tags.type = "text";
    tags.placeholder = "reading, idea";
    tags.addEventListener("keydown", handleEditorShortcut);
    tagLabel.append(tags);

    const colors = document.createElement("div");
    colors.className = "gh-annotator-editor__colors";
    colors.setAttribute("role", "radiogroup");
    colors.setAttribute("aria-label", "Highlight color");

    for (const color of ["yellow", "green", "blue", "pink"]) {
      const swatch = document.createElement("button");
      swatch.className = "gh-annotator-editor__swatch";
      swatch.type = "button";
      swatch.dataset.color = color;
      swatch.title = color;
      swatch.setAttribute("aria-label", color);
      swatch.addEventListener("click", () => selectEditorColor(color));
      colors.append(swatch);
    }

    const status = document.createElement("div");
    status.className = "gh-annotator-editor__status";
    status.setAttribute("aria-live", "polite");

    const actions = document.createElement("div");
    actions.className = "gh-annotator-editor__actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeEditor);

    const save = document.createElement("button");
    save.type = "button";
    save.dataset.primary = "true";
    save.textContent = "Save";
    save.addEventListener("click", saveEditorAnnotation);

    actions.append(cancel, save);
    body.append(quote, noteLabel, tagLabel, colors, status, actions);
    root.append(header, body);
    appendUiNode(root);

    return { root, title, quote, note, tags, status, save, draft: null, tempHighlightId: null };
  }

  function selectEditorColor(color) {
    editorColor = color;
    if (!editor) {
      return;
    }
    editor.root.querySelectorAll(".gh-annotator-editor__swatch").forEach((swatch) => {
      swatch.dataset.selected = String(swatch.dataset.color === color);
    });
    updateDraftHighlightColor(color);
  }

  async function saveEditorAnnotation() {
    if (!editor?.draft) {
      return;
    }

    editor.save.disabled = true;
    setEditorStatus("Saving...");

    const annotation = {
      ...editor.draft,
      note: editor.note.value.trim(),
      tags: parseTags(editor.tags.value),
      color: editorColor
    };

    try {
      const response = await sendRuntimeMessage({
        type: "SAVE_ANNOTATION",
        annotation
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not save annotation.");
      }

      annotationsById.set(response.annotation.id, response.annotation);
      if (!promoteDraftHighlight(response.annotation)) {
        applyAnnotations([response.annotation]);
      }
      updateAnnotationMarks(response.annotation);
      renderPagePanelAnnotations();
      const syncStatus = response.annotation.syncStatus || "synced";
      setEditorStatus(syncStatus === "synced" ? "Saved to GitHub." : "Queued for GitHub sync.", "success");
      window.setTimeout(closeEditor, 450);
    } catch (error) {
      setEditorStatus(error?.message || String(error), "error");
    } finally {
      editor.save.disabled = false;
    }
  }

  function handleEditorShortcut(event) {
    event.stopPropagation();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveEditorAnnotation();
    }
  }

  function setEditorStatus(message, kind = "") {
    if (!editor) {
      return;
    }
    editor.status.textContent = message;
    editor.status.dataset.visible = String(Boolean(message));
    if (kind) {
      editor.status.dataset.kind = kind;
    } else {
      delete editor.status.dataset.kind;
    }
  }

  function parseTags(value) {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  async function announceReady() {
    try {
      const response = await sendRuntimeMessage({
        type: "CONTENT_READY",
        page: { url: location.href, title: document.title }
      });
      updateUserSettings(response?.settings);
      debugLog("announceReady:response", {
        ok: response?.ok,
        count: response?.annotations?.length || 0,
        url: location.href
      });
      if (response?.ok && response.annotations?.length) {
        scheduleAnnotationApply(response.annotations, { observe: true });
      }
    } catch (error) {
      debugWarn("announceReady:failed", {
        message: error?.message || String(error)
      });
    }
  }

  function showDraftHighlight(draft) {
    clearDraftHighlight();
    const id = `${DRAFT_HIGHLIGHT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const range = findRange(draft.selector);
    if (!range) {
      debugWarn("showDraftHighlight:miss", {
        quote: (draft.selector?.exact || "").slice(0, 80),
        start: draft.selector?.start,
        end: draft.selector?.end
      });
      return "";
    }

    wrapRange(range, {
      id,
      color: editorColor,
      quote: draft.selector?.exact || ""
    });

    const marks = findHighlightMarks(id);
    marks.forEach((mark) => {
      mark.dataset.temporary = "true";
      mark.title = "Draft annotation";
    });

    debugLog("showDraftHighlight:done", {
      id,
      count: marks.length
    });
    return marks.length ? id : "";
  }

  function promoteDraftHighlight(annotation) {
    const tempHighlightId = editor?.tempHighlightId;
    if (!tempHighlightId || !annotation?.id) {
      return false;
    }

    const marks = findHighlightMarks(tempHighlightId);
    if (!marks.length) {
      return false;
    }

    marks.forEach((mark) => {
      mark.dataset.ghAnnotationId = annotation.id;
      mark.dataset.color = annotation.color || "yellow";
      mark.title = annotation.note || annotation.quote || "GitHub annotation";
      delete mark.dataset.temporary;
    });
    editor.tempHighlightId = null;

    debugLog("promoteDraftHighlight:done", {
      from: tempHighlightId,
      to: annotation.id,
      count: marks.length
    });
    return true;
  }

  function clearDraftHighlight(highlightId) {
    const marks = highlightId
      ? findHighlightMarks(highlightId)
      : [...document.querySelectorAll(`.${HIGHLIGHT_CLASS}[data-temporary="true"]`)];
    if (!marks.length) {
      return;
    }

    marks.forEach(unwrapHighlightMark);
    debugLog("clearDraftHighlight:done", {
      id: highlightId || "all",
      count: marks.length
    });
  }

  function updateDraftHighlightColor(color) {
    if (!editor?.tempHighlightId) {
      return;
    }
    findHighlightMarks(editor.tempHighlightId).forEach((mark) => {
      mark.dataset.color = color || "yellow";
    });
  }

  function findHighlightMarks(id) {
    if (!id) {
      return [];
    }
    return [...document.querySelectorAll(`[data-gh-annotation-id="${cssEscape(id)}"]`)];
  }

  function unwrapHighlightMark(mark) {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }

    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize?.();
  }

  function applyAnnotations(annotations) {
    let applied = 0;
    const misses = [];

    for (const annotation of annotations) {
      if (annotation?.id) {
        annotationsById.set(annotation.id, annotation);
      }

      if (!annotation?.id) {
        continue;
      }

      if (document.querySelector(`[data-gh-annotation-id="${cssEscape(annotation.id)}"]`)) {
        updateAnnotationMarks(annotation);
        applied += 1;
        continue;
      }

      const range = findRange(annotation.selector);
      if (range) {
        wrapRange(range, annotation);
        applied += 1;
      } else {
        misses.push({
          id: annotation.id,
          quote: (annotation.quote || annotation.selector?.exact || "").slice(0, 80),
          start: annotation.selector?.start,
          end: annotation.selector?.end
        });
      }
    }
    debugLog("applyAnnotations:done", {
      requested: annotations.length,
      applied,
      misses
    });
    renderPagePanelAnnotations();
    return applied;
  }

  function unappliedAnnotations(annotations) {
    return annotations.filter((annotation) => {
      if (!annotation?.id) {
        return false;
      }
      return !document.querySelector(`[data-gh-annotation-id="${cssEscape(annotation.id)}"]`);
    });
  }

  function scheduleAnnotationApply(annotations, options = {}) {
    const candidates = (annotations || []).filter((annotation) => annotation?.id && annotation?.selector?.exact);
    if (!candidates.length) {
      return;
    }

    debugLog("scheduleAnnotationApply:start", {
      count: candidates.length,
      observe: Boolean(options.observe)
    });
    const delays = [0, 250, 800, 1600, 3200, 6000];
    delays.forEach((delay) => {
      window.setTimeout(() => {
        const remaining = unappliedAnnotations(candidates);
        if (!remaining.length) {
          stopAnnotationObserver();
          return;
        }
        debugLog("scheduleAnnotationApply:retry", {
          delay,
          remaining: remaining.length
        });
        applyAnnotations(remaining);
      }, delay);
    });

    if (options.observe) {
      startAnnotationObserver(candidates);
    }
  }

  function startAnnotationObserver(annotations) {
    stopAnnotationObserver();
    const startedAt = Date.now();
    debugLog("startAnnotationObserver", { count: annotations.length });

    retryObserver = new MutationObserver(() => {
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        const remaining = unappliedAnnotations(annotations);
        if (!remaining.length || Date.now() - startedAt > 15000) {
          debugLog("annotationObserver:stop", {
            remaining: remaining.length,
            elapsed: Date.now() - startedAt
          });
          stopAnnotationObserver();
          return;
        }
        debugLog("annotationObserver:retry", { remaining: remaining.length });
        applyAnnotations(remaining);
      }, 180);
    });

    retryObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    window.setTimeout(stopAnnotationObserver, 16000);
  }

  function stopAnnotationObserver() {
    if (retryObserver) {
      retryObserver.disconnect();
      retryObserver = null;
    }
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function updateAnnotationMarks(annotation) {
    if (!annotation?.id) {
      return;
    }

    document.querySelectorAll(`[data-gh-annotation-id="${cssEscape(annotation.id)}"]`).forEach((mark) => {
      mark.dataset.color = annotation.color || "yellow";
      mark.title = annotation.note || annotation.quote || "GitHub annotation";
    });
  }

  function findRange(selector) {
    if (!selector?.exact) {
      return null;
    }

    const textIndex = buildTextIndex();
    const exact = selector.exact;
    let start = Number.isInteger(selector.start) ? selector.start : -1;

    if (start >= 0 && textIndex.fullText.slice(start, start + exact.length) !== exact) {
      start = -1;
    }

    if (start < 0) {
      start = findBestTextMatch(textIndex.fullText, selector);
    }

    if (start < 0) {
      return null;
    }

    return rangeFromOffsets(textIndex.nodes, start, start + exact.length);
  }

  function findBestTextMatch(fullText, selector) {
    const exact = selector.exact;
    const candidates = [];
    let index = fullText.indexOf(exact);

    while (index >= 0 && candidates.length < 80) {
      let score = 0;
      if (selector.prefix && fullText.slice(Math.max(0, index - selector.prefix.length), index) === selector.prefix) {
        score += selector.prefix.length;
      }
      if (selector.suffix && fullText.slice(index + exact.length, index + exact.length + selector.suffix.length) === selector.suffix) {
        score += selector.suffix.length;
      }
      candidates.push({ index, score });
      index = fullText.indexOf(exact, index + exact.length);
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.index ?? -1;
  }

  function rangeFromOffsets(nodes, start, end) {
    const startNode = findNodeAtOffset(nodes, start);
    const endNode = findNodeAtOffset(nodes, end, true);
    if (!startNode || !endNode) {
      return null;
    }

    const range = document.createRange();
    range.setStart(startNode.node, start - startNode.start);
    range.setEnd(endNode.node, end - endNode.start);
    return range;
  }

  function findNodeAtOffset(nodes, offset, preferPrevious = false) {
    for (const item of nodes) {
      if (offset >= item.start && offset < item.end) {
        return item;
      }
      if (preferPrevious && offset === item.end) {
        return item;
      }
    }
    return null;
  }

  function wrapRange(range, annotation) {
    const textNodes = collectTextNodesInRange(range);
    for (const node of textNodes) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (end <= start) {
        continue;
      }
      wrapTextNodeSlice(node, start, end, annotation);
    }
  }

  function collectTextNodesInRange(range) {
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim() || node.parentElement?.closest(SKIP_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }

    if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE && !nodes.includes(range.commonAncestorContainer)) {
      nodes.push(range.commonAncestorContainer);
    }

    return nodes;
  }

  function wrapTextNodeSlice(node, start, end, annotation) {
    const parent = node.parentNode;
    if (!parent || parent.closest?.(`.${HIGHLIGHT_CLASS}`)) {
      return;
    }

    let target = node;
    if (start > 0) {
      target = node.splitText(start);
    }

    if (end - start < target.nodeValue.length) {
      target.splitText(end - start);
    }

    const mark = document.createElement("mark");
    mark.className = HIGHLIGHT_CLASS;
    mark.dataset.ghAnnotationId = annotation.id;
    mark.dataset.color = annotation.color || "yellow";
    mark.title = annotation.note || annotation.quote || "GitHub annotation";
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }

  function focusAnnotation(id, scroll = true) {
    if (!id) {
      return;
    }
    const marks = [...document.querySelectorAll(`[data-gh-annotation-id="${cssEscape(id)}"]`)];
    if (!marks.length) {
      return;
    }

    document.querySelectorAll(`.${HIGHLIGHT_CLASS}[data-active="true"]`).forEach((node) => {
      delete node.dataset.active;
    });
    marks.forEach((node) => {
      node.dataset.active = "true";
    });
    if (scroll) {
      marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
    }
    window.setTimeout(() => {
      marks.forEach((node) => {
        delete node.dataset.active;
      });
    }, 2200);
  }

  function buildTextIndex() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, textNodeFilter);
    const nodes = [];
    let fullText = "";
    let node = walker.nextNode();

    while (node) {
      const start = fullText.length;
      fullText += node.nodeValue;
      nodes.push({ node, start, end: fullText.length });
      node = walker.nextNode();
    }

    return { nodes, fullText };
  }

  function textNodeFilter(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) {
      return NodeFilter.FILTER_REJECT;
    }
    if (node.parentElement?.closest(SKIP_SELECTOR)) {
      return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }

  function appendUiNode(node) {
    getUiRoot().append(node);
  }

  function getUiRoot() {
    if (uiRoot) {
      return uiRoot;
    }

    let host = document.getElementById(UI_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = UI_HOST_ID;
      host.style.all = "initial";
      document.documentElement.append(host);
    }

    uiRoot = host.shadowRoot || host.attachShadow({ mode: "open" });
    installUiEventGuards(uiRoot);
    if (!uiRoot.querySelector("[data-gh-annotator-style]")) {
      const stylesheet = document.createElement("link");
      stylesheet.dataset.ghAnnotatorStyle = "true";
      stylesheet.rel = "stylesheet";
      stylesheet.href = chrome.runtime.getURL("content/content-style.css");
      uiRoot.append(stylesheet);
    }

    return uiRoot;
  }

  function installUiEventGuards(root) {
    if (root.__ghAnnotatorGuardsInstalled) {
      return;
    }

    root.__ghAnnotatorGuardsInstalled = true;
    ["keydown", "keypress", "keyup"].forEach((type) => {
      root.addEventListener(type, stopUiEventPropagation);
    });
  }

  function stopUiEventPropagation(event) {
    event.stopPropagation();
  }

  function isAnnotatorUi(target) {
    return Boolean(target?.closest?.(`#${UI_HOST_ID}, .gh-annotator-toolbar, .gh-annotator-editor, .gh-annotator-detail, .gh-annotator-panel`));
  }

  function isEditableTarget(target) {
    return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
  }

  function updateUserSettings(settings = {}) {
    if (Object.prototype.hasOwnProperty.call(settings, "showSelectionToolbar")) {
      userSettingsLoaded = true;
    }

    userSettings = {
      ...userSettings,
      showSelectionToolbar: settings.showSelectionToolbar ?? userSettings.showSelectionToolbar,
      activationShortcut: settings.activationShortcut || userSettings.activationShortcut,
      clipShortcut: settings.clipShortcut || userSettings.clipShortcut,
      backgroundSync: settings.backgroundSync ?? userSettings.backgroundSync
    };
    if (!userSettings.showSelectionToolbar) {
      hideToolbar();
    }
    debugLog("updateUserSettings", userSettings);
  }

  function shouldShowSelectionToolbar() {
    return userSettingsLoaded && userSettings.showSelectionToolbar;
  }

  function withPreservedScroll(callback) {
    const position = currentScrollPosition();
    const result = callback();
    restoreScrollPosition(position);
    window.requestAnimationFrame(() => restoreScrollPosition(position));
    return result;
  }

  function focusWithoutScrolling(node) {
    const position = currentScrollPosition();
    try {
      node.focus({ preventScroll: true });
    } catch (_error) {
      node.focus();
    }
    restoreScrollPosition(position);
    window.requestAnimationFrame(() => restoreScrollPosition(position));
  }

  function currentScrollPosition() {
    return {
      x: window.scrollX,
      y: window.scrollY
    };
  }

  function restoreScrollPosition(position) {
    if (!position) {
      return;
    }
    if (window.scrollX !== position.x || window.scrollY !== position.y) {
      window.scrollTo(position.x, position.y);
    }
  }

  function shortcutMatches(event, shortcut) {
    const parsed = parseShortcut(shortcut);
    if (!parsed.key) {
      return false;
    }

    return event.ctrlKey === parsed.ctrl
      && event.metaKey === parsed.meta
      && event.altKey === parsed.alt
      && event.shiftKey === parsed.shift
      && normalizeEventKey(event.key) === parsed.key;
  }

  function parseShortcut(shortcut) {
    const parsed = {
      key: "",
      ctrl: false,
      meta: false,
      alt: false,
      shift: false
    };

    String(shortcut || "Ctrl+E")
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const lower = part.toLowerCase();
        if (lower === "ctrl" || lower === "control") {
          parsed.ctrl = true;
        } else if (lower === "cmd" || lower === "command" || lower === "meta") {
          parsed.meta = true;
        } else if (lower === "alt" || lower === "option") {
          parsed.alt = true;
        } else if (lower === "shift") {
          parsed.shift = true;
        } else {
          parsed.key = normalizeEventKey(part);
        }
      });

    return parsed;
  }

  function normalizeEventKey(key) {
    const value = String(key || "");
    return value.length === 1 ? value.toLowerCase() : value.toLowerCase();
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function sendRuntimeMessage(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return Promise.reject(new Error("Extension connection is stale. Reload this page and try again."));
    }
    return chrome.runtime.sendMessage(message);
  }

  function showEditorRuntimeError(error) {
    if (editor?.root && !editor.root.hidden) {
      setEditorStatus(error?.message || String(error), "error");
    }
  }

  function debugLog(label, details = {}) {
    if (DEBUG) {
      console.info(`[GitHub Annotator CS] ${label}`, details);
    }
  }

  function debugWarn(label, details = {}) {
    if (DEBUG) {
      console.warn(`[GitHub Annotator CS] ${label}`, details);
    }
  }
})();
