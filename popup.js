const DEFAULT_SETTINGS = {
    enableCaseInsensitiveWords: true,
    enableCaseSensitiveWords: true,
    enablePunctuation: true,
    enableOrangeAngle: true,
    enableGKLookup: true,
    enableTabDedup: true,
    showRatingHelper: true,
    enableSkipGuard: true,
    wordsToHighlight: ["niner", "alpha", "fourty", "romeu", "ninty", "juliet"],
    wordsToHighlightCaseSensitive: ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "x-ray", "yankee", "zulu", "HEAVY", "Tower", "Approach", "Center", "Departure", "I", "It", "rnav", "rnp", "ils"]
};

const elements = {
    enableCaseInsensitiveWords: document.getElementById('enableCaseInsensitiveWords'),
    enableCaseSensitiveWords: document.getElementById('enableCaseSensitiveWords'),
    enablePunctuation: document.getElementById('enablePunctuation'),
    enableOrangeAngle: document.getElementById('enableOrangeAngle'),
    enableGKLookup: document.getElementById('enableGKLookup'),
    enableTabDedup: document.getElementById('enableTabDedup'),
    showRatingHelper: document.getElementById('showRatingHelper'),
    enableSkipGuard: document.getElementById('enableSkipGuard'),
    wordsToHighlight: document.getElementById('wordsToHighlight'),
    wordsToHighlightCaseSensitive: document.getElementById('wordsToHighlightCaseSensitive'),
    save: document.getElementById('save'),
    status: document.getElementById('status')
};

const remoteEl = {
    status: document.getElementById('remote-status'),
    undoBtn: document.getElementById('undo-btn'),
    removedList: document.getElementById('removed-list'),
    removedAddRow: document.getElementById('removed-add-row'),
    removedInput: document.getElementById('removed-input'),
    removedAddBtn: document.getElementById('removed-add-btn'),
    auditList: document.getElementById('audit-list'),
    auditAddRow: document.getElementById('audit-add-row'),
    auditInput: document.getElementById('audit-input'),
    auditAddBtn: document.getElementById('audit-add-btn'),
    srflagList: document.getElementById('srflag-list'),
    srflagAddRow: document.getElementById('srflag-add-row'),
    srflagInput: document.getElementById('srflag-input'),
    srflagComment: document.getElementById('srflag-comment'),
    srflagAddBtn: document.getElementById('srflag-add-btn'),
    srflagPasteBtn: document.getElementById('srflag-paste-btn'),
    srflagTranscriptBtn: document.getElementById('srflag-transcript-btn'),
    flagStatus: document.getElementById('flag-status'),
    tlPassword: document.getElementById('tl-password'),
    gistId: document.getElementById('gist-id'),
    writeUrl: document.getElementById('write-url'),
    driveFileId: document.getElementById('drive-file-id'),
    driveRefreshBtn: document.getElementById('drive-refresh-btn'),
    driveStatus: document.getElementById('drive-status'),
    remoteSave: document.getElementById('remote-save'),
    remoteSaveStatus: document.getElementById('remote-save-status')
};

const gkEl = {
    panel: document.getElementById('gk-lookup-panel'),
    input: document.getElementById('gk-input'),
    pasteBtn: document.getElementById('gk-paste-btn'),
    goBtn: document.getElementById('gk-go-btn'),
    status: document.getElementById('gk-status')
};

// ── Navigation ───────────────────────────────────────────────────────────────

const nav = {
    reports: document.getElementById('nav-reports'),
    lists: document.getElementById('nav-lists'),
    config: document.getElementById('nav-config'),
    viewReports: document.getElementById('view-reports'),
    viewLists: document.getElementById('view-lists'),
    viewConfig: document.getElementById('view-config')
};

function switchView(target) {
    const tabs = ['reports', 'lists', 'config'];
    tabs.forEach(t => {
        nav[t].classList.toggle('active', t === target);
        nav[`view${t.charAt(0).toUpperCase() + t.slice(1)}`].classList.toggle('hidden', t !== target);
    });
}

nav.reports.addEventListener('click', () => switchView('reports'));
nav.lists.addEventListener('click', () => switchView('lists'));
nav.config.addEventListener('click', () => switchView('config'));

// ── Core settings ──────────────────────────────────────────────────────────────

function parseCsv(value) {
    return value
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function toCsv(values) {
    return values.join(', ');
}

function render(settings) {
    elements.enableCaseInsensitiveWords.checked = settings.enableCaseInsensitiveWords;
    elements.enableCaseSensitiveWords.checked = settings.enableCaseSensitiveWords;
    elements.enablePunctuation.checked = settings.enablePunctuation;
    elements.enableOrangeAngle.checked = settings.enableOrangeAngle;
    elements.enableGKLookup.checked = settings.enableGKLookup;
    elements.enableTabDedup.checked = settings.enableTabDedup;
    elements.showRatingHelper.checked = settings.showRatingHelper;
    elements.enableSkipGuard.checked = settings.enableSkipGuard;
    elements.wordsToHighlight.value = toCsv(settings.wordsToHighlight);
    elements.wordsToHighlightCaseSensitive.value = toCsv(settings.wordsToHighlightCaseSensitive);

    gkEl.panel.classList.toggle('hidden', !settings.enableGKLookup);
}

function collectSettingsFromForm() {
    return {
        enableCaseInsensitiveWords: elements.enableCaseInsensitiveWords.checked,
        enableCaseSensitiveWords: elements.enableCaseSensitiveWords.checked,
        enablePunctuation: elements.enablePunctuation.checked,
        enableOrangeAngle: elements.enableOrangeAngle.checked,
        enableGKLookup: elements.enableGKLookup.checked,
        enableTabDedup: elements.enableTabDedup.checked,
        showRatingHelper: elements.showRatingHelper.checked,
        enableSkipGuard: elements.enableSkipGuard.checked,
        wordsToHighlight: parseCsv(elements.wordsToHighlight.value),
        wordsToHighlightCaseSensitive: parseCsv(elements.wordsToHighlightCaseSensitive.value)
    };
}

function save() {
    const settings = collectSettingsFromForm();
    chrome.storage.local.set(settings, () => {
        showStatus('Saved');
        gkEl.panel.classList.toggle('hidden', !settings.enableGKLookup);
    });
}

function saveRatingHelperVisibility() {
    const showRatingHelper = elements.showRatingHelper.checked;
    const update = showRatingHelper
        ? { showRatingHelper, _lbhWidgetHidden: false }
        : { showRatingHelper };

    chrome.storage.local.set(update, () => {
        showStatus('Saved');
    });
}

function saveSkipGuardToggle() {
    chrome.storage.local.set({ enableSkipGuard: elements.enableSkipGuard.checked }, () => {
        showStatus('Saved');
    });
}

chrome.storage.local.get(DEFAULT_SETTINGS, stored => {
    const initialSettings = { ...DEFAULT_SETTINGS, ...stored };
    render(initialSettings);
});

// Opening the popup restores the badge if it was dismissed
chrome.storage.local.set({ _lbhWidgetHidden: false });

elements.save.addEventListener('click', save);
elements.showRatingHelper.addEventListener('change', saveRatingHelperVisibility);
elements.enableSkipGuard.addEventListener('change', saveSkipGuardToggle);

// ── GK Lookup ─────────────────────────────────────────────────────────────────

let gkMap = null;

function parseNdjsonToMap(text) {
    const map = {};
    let count = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const row = JSON.parse(trimmed);
            const gk = row.data_row?.global_key;
            const drId = row.data_row?.id;
            const projectId = Object.keys(row.projects || {})[0];
            if (drId && projectId) {
                const entry = { drId, projectId };
                map[drId] = entry;
                if (gk) map[gk] = entry;
                count++;
            }
        } catch {}
    }
    return { map, count };
}

function setDriveStatus(msg, color) {
    remoteEl.driveStatus.textContent = msg;
    remoteEl.driveStatus.style.color = color || '#e5e7eb';
}

async function loadGKMap() {
    if (gkMap) return gkMap;

    // Prefer cached map from a previous Drive refresh
    const { _lbhGKCache, _lbhGKCacheTime, _lbhGKCacheCount } = await chrome.storage.local.get(['_lbhGKCache', '_lbhGKCacheTime', '_lbhGKCacheCount']);
    if (_lbhGKCache) {
        gkMap = _lbhGKCache;
        if (_lbhGKCacheTime) {
            const age = formatRelativeTime(_lbhGKCacheTime);
            const rows = _lbhGKCacheCount ?? Object.keys(gkMap).length;
            setDriveStatus(`${rows.toLocaleString()} rows · refreshed ${age}`, '#e5e7eb');
            setGKStatus(`${rows.toLocaleString()} rows loaded`);
        }
        return gkMap;
    }

    // No cache — prompt the user to refresh from Drive
    gkMap = {};
    setGKStatus('No data — use Refresh (new batch) in Lists → Remote Settings', '#f87171');
    return gkMap;
}

async function refreshFromDrive() {
    const fileId = remoteEl.driveFileId.value.trim();
    if (!fileId) {
        setDriveStatus('No Drive file ID set', '#ef4444');
        return;
    }

    remoteEl.driveRefreshBtn.disabled = true;
    setDriveStatus('Downloading…', '#e5e7eb');

    try {
        const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&authuser=0&confirm=t`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const text = await resp.text();
        const { map: freshMap, count } = parseNdjsonToMap(text);

        if (count === 0) throw new Error('No rows parsed — check file format');

        const now = Date.now();
        await chrome.storage.local.set({ _lbhGKCache: freshMap, _lbhGKCacheTime: now, _lbhGKCacheCount: count });
        gkMap = freshMap;

        setDriveStatus(`${count.toLocaleString()} rows loaded · refreshed just now`, '#34d399');
        setGKStatus(`${count.toLocaleString()} rows loaded`);
    } catch (e) {
        console.error('Drive refresh failed', e);
        setDriveStatus(`Refresh failed: ${e.message}`, '#ef4444');
    } finally {
        remoteEl.driveRefreshBtn.disabled = false;
    }
}

function setGKStatus(msg, colorOrError = false) {
    gkEl.status.textContent = msg;
    if (typeof colorOrError === 'string') {
        gkEl.status.style.color = colorOrError;
    } else {
        gkEl.status.style.color = colorOrError ? '#ef4444' : '#e5e7eb';
    }
}

async function navigateGK() {
    const gk = gkEl.input.value.trim();
    if (!gk) return;

    gkEl.goBtn.disabled = true;
    setGKStatus('Looking up…');

    try {
        const map = await loadGKMap();
        const entry = map[gk];
        if (!entry) {
            setGKStatus(`Not found: ${gk}`, true);
            return;
        }
        const url = `https://app.labelbox.com/projects/${entry.projectId}/data-rows/${entry.drId}`;
        chrome.tabs.create({ url });
    } catch (err) {
        setGKStatus('Failed to load data.ndjson', true);
    } finally {
        gkEl.goBtn.disabled = false;
    }
}

gkEl.goBtn.addEventListener('click', navigateGK);
gkEl.input.addEventListener('keydown', e => { if (e.key === 'Enter') navigateGK(); });
gkEl.pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        gkEl.input.value = text.trim();
        gkEl.input.focus();
    } catch {
        setGKStatus('Clipboard access denied', true);
    }
});

// Preload in background so first lookup is instant
chrome.storage.local.get({ enableGKLookup: true }, ({ enableGKLookup }) => {
    if (enableGKLookup) {
        loadGKMap().then(() => {
        }).catch(() => {
            setGKStatus('Failed to load data', '#f87171');
        });
    }
});

// ── Remote / community lists ───────────────────────────────────────────────────

let remoteRemoved = [];
let remoteCommunityAudit = [];
let remoteSrFlag = [];
let gistId = '';
let writeUrl = '';
let gistFilename = 'lbx-lists.json';
let undoSnapshot = null;
let isTL = false;
const TL_PASSWORD = 'ZoomFilterScan60';

function captureUndo() {
    undoSnapshot = {
        removed: [...remoteRemoved],
        audit: [...remoteCommunityAudit],
        srFlag: [...remoteSrFlag]
    };
    remoteEl.undoBtn.disabled = false;
}

async function applyUndo() {
    if (!undoSnapshot) return;
    remoteRemoved = undoSnapshot.removed;
    remoteCommunityAudit = undoSnapshot.audit;
    remoteSrFlag = undoSnapshot.srFlag;
    undoSnapshot = null;
    remoteEl.undoBtn.disabled = true;
    await saveRemoteLists();
    renderCommunityLists();
}

function extractGistId(value) {
    const trimmed = value.trim();
    const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([a-f0-9]+)/i);
    if (urlMatch) return urlMatch[1];
    return trimmed;
}

function formatRelativeTime(ts) {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ago`;
}

function setStatus(el, text, color, duration = 1500) {
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '';
    if (duration > 0) {
        setTimeout(() => {
            if (el.textContent === text) el.textContent = '';
        }, duration);
    }
}

function showStatus(message) {
    setStatus(elements.status, message, '#34d399');
}

function setRemoteStatus(text, color) {
    setStatus(remoteEl.status, text, color, 0);
}

function renderChipList(container, items, onRemove, isMasked = false) {
    container.innerHTML = '';
    if (items.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'chip-empty';
        empty.textContent = 'No entries';
        container.appendChild(empty);
        return;
    }

    if (isMasked && !isTL) {
        const summary = document.createElement('span');
        summary.className = 'chip-summary';
        const uniqueCount = new Set(items).size;
        summary.textContent = `${uniqueCount} unique IDs flagged (${items.length} total flags)`;
        container.appendChild(summary);
        return;
    }

    const itemCounts = {};
    items.forEach(item => {
        itemCounts[item] = (itemCounts[item] || 0) + 1;
    });

    const uniqueItems = [...new Set(items)].sort();

    uniqueItems.forEach(item => {
        const count = itemCounts[item];
        const chip = document.createElement('span');
        chip.className = 'chip';

        const textNode = document.createTextNode(count > 1 ? `${item} (${count})` : item);
        chip.appendChild(textNode);

        if (onRemove) {
            const btn = document.createElement('button');
            btn.className = 'chip-remove';
            btn.textContent = '×';
            btn.title = 'Remove one';
            btn.addEventListener('click', () => {
                const index = items.indexOf(item);
                if (index !== -1) {
                    onRemove(index);
                }
            });
            chip.appendChild(btn);
        }
        container.appendChild(chip);
    });
}

function renderCommunityLists() {
    const canEdit = !!writeUrl;
    const canEditTL = canEdit && isTL;

    const passContainer = document.getElementById('tl-password-container');
    if (passContainer) passContainer.classList.toggle('hidden', !canEdit);

    if (isTL) {
        renderChipList(remoteEl.removedList, remoteRemoved, canEditTL ? async index => {
            captureUndo();
            remoteRemoved.splice(index, 1);
            await saveRemoteLists();
            renderCommunityLists();
        } : null);

        renderChipList(remoteEl.auditList, remoteCommunityAudit, canEditTL ? async index => {
            captureUndo();
            remoteCommunityAudit.splice(index, 1);
            await saveRemoteLists();
            renderCommunityLists();
        } : null);
    } else {
        const dotPink = '<span class="status-dot status-dot--pink"></span>';
        const dotPurple = '<span class="status-dot status-dot--purple"></span>';
        remoteEl.removedList.innerHTML = `${dotPink} <span class="chip-summary">${remoteRemoved.length} entries active</span>`;
        remoteEl.auditList.innerHTML = `${dotPurple} <span class="chip-summary">${remoteCommunityAudit.length} entries active</span>`;
    }

    renderChipList(remoteEl.srflagList, remoteSrFlag, canEditTL ? async index => {
        captureUndo();
        remoteSrFlag.splice(index, 1);
        await saveRemoteLists();
        renderCommunityLists();
    } : null, true);

    remoteEl.removedAddRow.classList.toggle('hidden', !canEditTL);
    remoteEl.auditAddRow.classList.toggle('hidden', !canEditTL);
    remoteEl.srflagAddRow.classList.toggle('hidden', !canEdit);
}

async function fetchAndRenderGist(force = false) {
    if (!gistId) return;

    const { _lbhRemoteLastFetch } = await chrome.storage.local.get(['_lbhRemoteLastFetch']);
    const now = Date.now();
    if (!force && _lbhRemoteLastFetch && (now - _lbhRemoteLastFetch < 120000)) {
        if (_lbhRemoteLastFetch > 0) {
            setRemoteStatus(`Synced ${formatRelativeTime(_lbhRemoteLastFetch)}`, '#e5e7eb');
        }
        return;
    }

    setRemoteStatus('Fetching…', '#e5e7eb');

    try {
        const response = await fetch(`https://api.github.com/gists/${gistId}`);
        if (response.status === 403) {
            throw new Error('Rate limit exceeded. Try again in a few minutes.');
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const filename = Object.keys(data.files)[0];
        if (!filename) throw new Error('Empty gist');
        gistFilename = filename;

        const content = JSON.parse(data.files[filename].content);
        remoteRemoved = Array.isArray(content.removed) ? content.removed : [];
        remoteCommunityAudit = Array.isArray(content.communityAudit) ? content.communityAudit : [];
        remoteSrFlag = Array.isArray(content.srFlag) ? content.srFlag : [];

        const now = Date.now();
        await chrome.storage.local.set({
            _lbhGistFilename: filename,
            _lbhRemoteRemoved: remoteRemoved,
            _lbhRemoteCommunityAudit: remoteCommunityAudit,
            _lbhRemoteSrFlag: remoteSrFlag,
            _lbhRemoteLastFetch: now
        });

        setRemoteStatus('Synced just now', '#34d399');
        renderCommunityLists();
    } catch (e) {
        console.error('Super Highlighter: Gist fetch error', e);
        setRemoteStatus(`Fetch failed: ${e.message}`, '#ef4444');
    }
}

async function saveRemoteLists() {
    const now = Date.now();
    await chrome.storage.local.set({
        _lbhRemoteRemoved: remoteRemoved,
        _lbhRemoteCommunityAudit: remoteCommunityAudit,
        _lbhRemoteSrFlag: remoteSrFlag,
        _lbhRemoteLastFetch: now
    });

    if (!writeUrl) return;

    try {
        const resp = await fetch(writeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({
                removed: remoteRemoved,
                communityAudit: remoteCommunityAudit,
                srFlag: remoteSrFlag
            })
        });
        const res = await resp.json();
        if (res.ok) {
            setRemoteStatus('Synced just now', '#34d399');
        } else {
            throw new Error(res.error);
        }
    } catch (e) {
        console.error('Save failed', e);
        setRemoteStatus('Save failed', '#ef4444');
    }
}

async function addItem(type, value, comment = '') {
    const trimmed = value.trim();
    if (!trimmed) return;

    captureUndo();

    if (type === 'removed') {
        remoteRemoved.push(trimmed);
        remoteEl.removedInput.value = '';
        setStatus(remoteEl.status, 'Added to Removed', '#34d399');
        await saveRemoteLists();
    } else if (type === 'audit') {
        remoteCommunityAudit.push(trimmed);
        remoteEl.auditInput.value = '';
        setStatus(remoteEl.status, 'Added to Audit', '#34d399');
        await saveRemoteLists();
    } else {
        if (remoteRemoved.includes(trimmed)) {
            setStatus(remoteEl.flagStatus, 'Already removed', '#ef4444', 3000);
            return;
        }
        if (remoteCommunityAudit.includes(trimmed)) {
            setStatus(remoteEl.flagStatus, 'Being community audited', '#ef4444', 3000);
            return;
        }

        const alreadyExists = remoteSrFlag.includes(trimmed);

        if (writeUrl) {
            setStatus(remoteEl.flagStatus, 'Flagging...', '#e5e7eb', 0);
            try {
                const resp = await fetch(writeUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify({ action: 'flag', id: trimmed, comment: comment })
                });
                const res = await resp.json();
                if (res.ok) {
                    if (!alreadyExists) {
                        remoteSrFlag.push(trimmed);
                        setStatus(remoteEl.flagStatus, 'Flagged', '#34d399', 3000);
                    } else {
                        setStatus(remoteEl.flagStatus, `Added +1 flag, ${res.count} total`, '#34d399', 3000);
                    }
                    remoteEl.srflagInput.value = '';
                    remoteEl.srflagComment.value = '';
                    setRemoteStatus('Synced just now', '#34d399');
                } else {
                    throw new Error(res.error);
                }
            } catch (e) {
                console.error('Flag failed', e);
                setStatus(remoteEl.flagStatus, 'Flag failed', '#ef4444', 3000);
                return;
            }
        } else {
            remoteSrFlag.push(trimmed);
            remoteEl.srflagInput.value = '';
            remoteEl.srflagComment.value = '';
            if (!alreadyExists) setStatus(remoteEl.flagStatus, 'Flagged (local)', '#34d399', 3000);
        }

        await chrome.storage.local.set({
            _lbhRemoteSrFlag: remoteSrFlag,
            _lbhRemoteLastFetch: Date.now()
        });
    }

    renderCommunityLists();
}

function formatTranscriptComment(capture) {
    const beforeText = (capture?.before?.displayText || capture?.before?.text || '').trim();
    const afterText = (capture?.after?.displayText || capture?.after?.text || '').trim();
    if (!beforeText || !afterText) return '';

    return `Before:\n${beforeText}\n\nAfter:\n${afterText}`;
}

async function pasteTranscriptComment() {
    const { _lbhTranscriptionCapture } = await chrome.storage.local.get(['_lbhTranscriptionCapture']);
    const comment = formatTranscriptComment(_lbhTranscriptionCapture);

    if (!comment) {
        setStatus(remoteEl.flagStatus, 'No transcript capture found', '#ef4444', 3000);
        return;
    }

    remoteEl.srflagComment.value = comment;
    remoteEl.srflagComment.focus();
    setStatus(remoteEl.flagStatus, 'Transcript pasted', '#34d399', 2000);
}

// Load remote state on popup open
chrome.storage.local.get({
    _lbhGistId: '5c272fb9bcef9a069bed8e976b47b150',
    _lbhWriteUrl: 'https://script.google.com/macros/s/AKfycbzjMmVDAoVanlR6VlvNChWueV5M-5aHZdS2mn3RPhWuPiQM8paJHqcVhg6vDFIJun62/exec',
    _lbhDriveFileId: '1TyuYqUqmwZVg9WJii89BYUTnd7wrPAnx',
    _lbhIsTL: false,
    _lbhGistFilename: 'lbx-lists.json',
    _lbhRemoteRemoved: [],
    _lbhRemoteCommunityAudit: [],
    _lbhRemoteSrFlag: [],
    _lbhRemoteLastFetch: 0,
    _lbhGKCacheTime: 0
}, stored => {
    gistId = stored._lbhGistId || '';
    writeUrl = stored._lbhWriteUrl || '';
    gistFilename = stored._lbhGistFilename || 'lbx-lists.json';
    remoteRemoved = Array.isArray(stored._lbhRemoteRemoved) ? stored._lbhRemoteRemoved : [];
    remoteCommunityAudit = Array.isArray(stored._lbhRemoteCommunityAudit) ? stored._lbhRemoteCommunityAudit : [];
    remoteSrFlag = Array.isArray(stored._lbhRemoteSrFlag) ? stored._lbhRemoteSrFlag : [];

    remoteEl.gistId.value = gistId;
    remoteEl.writeUrl.value = writeUrl;
    remoteEl.driveFileId.value = stored._lbhDriveFileId || '';

    if (stored._lbhIsTL) {
        isTL = true;
        remoteEl.tlPassword.value = TL_PASSWORD;
    }

    if (stored._lbhGKCacheTime > 0) {
        setDriveStatus(`Last refreshed ${formatRelativeTime(stored._lbhGKCacheTime)}`, '#e5e7eb');
    }

    if (stored._lbhRemoteLastFetch > 0) {
        setRemoteStatus(`Synced ${formatRelativeTime(stored._lbhRemoteLastFetch)}`, '#e5e7eb');
    } else if (!gistId) {
        setRemoteStatus('Not configured', '#e5e7eb');
    }

    renderCommunityLists();

    if (gistId) fetchAndRenderGist();
});

remoteEl.driveRefreshBtn.addEventListener('click', refreshFromDrive);

// Remote settings save
remoteEl.remoteSave.addEventListener('click', async () => {
    gistId = extractGistId(remoteEl.gistId.value);
    writeUrl = remoteEl.writeUrl.value.trim();
    const driveFileId = remoteEl.driveFileId.value.trim();

    remoteEl.gistId.value = gistId;

    await chrome.storage.local.set({ _lbhGistId: gistId, _lbhWriteUrl: writeUrl, _lbhDriveFileId: driveFileId });

    remoteEl.remoteSaveStatus.textContent = 'Saved';
    setTimeout(() => { remoteEl.remoteSaveStatus.textContent = ''; }, 1200);

    renderCommunityLists();
    if (gistId) fetchAndRenderGist();
});

// Undo
remoteEl.undoBtn.addEventListener('click', applyUndo);

// Add buttons and Enter key
remoteEl.removedAddBtn.addEventListener('click', () => addItem('removed', remoteEl.removedInput.value));
remoteEl.removedInput.addEventListener('keydown', e => { if (e.key === 'Enter') addItem('removed', remoteEl.removedInput.value); });

remoteEl.auditAddBtn.addEventListener('click', () => addItem('audit', remoteEl.auditInput.value));
remoteEl.auditInput.addEventListener('keydown', e => { if (e.key === 'Enter') addItem('audit', remoteEl.auditInput.value); });

remoteEl.srflagAddBtn.addEventListener('click', () => addItem('srflag', remoteEl.srflagInput.value, remoteEl.srflagComment.value));
remoteEl.srflagTranscriptBtn.addEventListener('click', pasteTranscriptComment);
remoteEl.srflagInput.addEventListener('keydown', e => { if (e.key === 'Enter') addItem('srflag', remoteEl.srflagInput.value, remoteEl.srflagComment.value); });
remoteEl.srflagComment.addEventListener('keydown', e => { if (e.key === 'Enter') addItem('srflag', remoteEl.srflagInput.value, remoteEl.srflagComment.value); });

remoteEl.srflagPasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            remoteEl.srflagInput.value = text.trim();
            remoteEl.srflagInput.focus();
        }
    } catch (err) {
        setStatus(remoteEl.flagStatus, 'Clipboard access denied', '#ef4444');
    }
});

remoteEl.tlPassword.addEventListener('input', e => {
    isTL = e.target.value === TL_PASSWORD;
    chrome.storage.local.set({ _lbhIsTL: isTL });
    renderCommunityLists();
});
