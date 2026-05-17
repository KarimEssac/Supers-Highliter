const DEFAULT_SETTINGS = {
    enabled: true,
    enableCaseInsensitiveWords: true,
    enableCaseSensitiveWords: true,
    enablePunctuation: true,
    enableOrangeAngle: true,
    wordsToHighlight: ["niner", "alpha", "fourty", "romeu", "ninty", "juliet"],
    wordsToHighlightCaseSensitive: ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "x-ray", "yankee", "zulu", "HEAVY", "Tower", "Approach", "Center", "Departure", "I", "It", "rnav", "rnp", "ils"]
};

const nonAnglePunctuationRegex = /[!"#$%&()*+/:;=?@[\\\]^_`{|}~-]/g;
const permittedBracketOnlyTexts = [
    "[unintelligible]",
    "[overlap talking]"
];

const redBorderColor = "4px solid #ff0000";
const orangeBorderColor = "4px solid #ff9900";
const pinkBorderColor = "4px solid #f472b6";
const purpleBorderColor = "4px solid #a855f7";
const blueBorderColor = "4px solid #3b82f6";
const redTextHighlightColor = "rgba(255, 0, 0, 0.30)";
const orangeTextHighlightColor = "rgba(255, 153, 0, 0.35)";
const pinkTextHighlightColor = "rgba(244, 114, 182, 0.35)";
const purpleTextHighlightColor = "rgba(168, 85, 247, 0.35)";
const blueTextHighlightColor = "rgba(59, 130, 246, 0.35)";
const TARGET_SELECTOR = 'textarea, div.vis-item-content';
const DEBUG_LOGS = false;
const ROLE_ASSIGNMENTS_CACHE_MS = 350;
const WIDGET_COLLAPSED_WIDTH_PX = 320;
const WIDGET_EXPANDED_DEFAULT_WIDTH_PX = 520;
const WIDGET_EXPANDED_DEFAULT_HEIGHT_PX = 430;

let settings = { ...DEFAULT_SETTINGS, remoteRemoved: [], remoteCommunityAudit: [], remoteSrFlag: [] };
let isCheckScheduled = false;
let isCheckRunning = false;
let shouldRunAgain = false;
let needsFullReset = false;
let domObserver = null;
let highlightWatchdog = null;
let widgetDismissed = false;
// TT sourced from network interception (-1 = not yet received)
let networkTtMs = -1;
// Timeline selection state (top frame only)
let selectionDurationMs = -1;
let transcriptPanelExpanded = false;
let referenceModal = null;
let transcriptionCapture = { rowKey: '', before: null, after: null, metrics: null };
let childFrameTranscript = { rowKey: '', savedSnapshot: null, liveSnapshot: null };
let lastSavedTranscriptionSignature = '';
let speakerRoleAssignmentsCache = { rowKey: '', at: 0, map: new Map() };
let transcriptCopyStatus = { side: '', at: 0, timer: null };
let lastRenderedWidgetHtml = '';
let widgetExpandedSize = {
    width: WIDGET_EXPANDED_DEFAULT_WIDTH_PX,
    height: WIDGET_EXPANDED_DEFAULT_HEIGHT_PX
};

// ── Word Count Widget ─────────────────────────────────────────────────────────

let wordCountWidget = null;

function isWidgetResizeHandlePress(widget, e) {
    if (!transcriptPanelExpanded) return false;
    const rect = widget.getBoundingClientRect();
    const handleSize = 20;
    return e.clientX >= rect.right - handleSize && e.clientY >= rect.bottom - handleSize;
}

function suppressNextWidgetToggle(widget, delayMs = 450) {
    widget.dataset.lbhSkipToggleClick = 'true';
    window.setTimeout(() => {
        if (widget.dataset.lbhSkipToggleClick === 'true') {
            delete widget.dataset.lbhSkipToggleClick;
        }
    }, delayMs);
}

function toggleTranscriptPanel() {
    if (transcriptPanelExpanded && wordCountWidget) {
        persistWidgetExpandedSize(wordCountWidget);
    }
    transcriptPanelExpanded = !transcriptPanelExpanded;
    if (settings.enabled) updateWordCount();
}

function countWordsInText(text) {
    if (!text) return 0;
    // Strip bracketed annotations like [unintelligible], [overlap talking]
    const stripped = text.replace(/\[.*?\]/g, '');
    return stripped.trim().split(/\s+/).filter(token => token.length > 0).length;
}

function normalizeSegmentText(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n/g, '\n')
        .trim();
}

function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function closestFromEventTarget(target, selector) {
    if (!target) return null;
    const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    return element && element.closest ? element.closest(selector) : null;
}

function getCurrentDataRowKey() {
    const match = window.location.pathname.match(/\/projects\/([^/]+)\/data-rows\/([^/?#]+)/);
    if (!match) return window.location.pathname;
    return `${match[1]}/${match[2]}`;
}

function getTimelineItemForElement(el) {
    return el && el.closest ? el.closest('.vis-item') : null;
}

function getTimelineItemSortKey(item) {
    if (!item) return { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER };

    const rect = item.getBoundingClientRect();
    const transform = item.style && item.style.transform;
    const translateMatch = transform && (
        transform.match(/translateX\(([-\d.]+)px\)/)
        || transform.match(/translate3d\(([-\d.]+)px/i)
        || transform.match(/translate\(([-\d.]+)px/i)
    );
    const x = translateMatch ? parseFloat(translateMatch[1]) : rect.left;

    return {
        x: Number.isFinite(x) ? x : rect.left,
        y: rect.top
    };
}

function compareTranscriptElementsByTimeline(a, b) {
    const aKey = getTimelineItemSortKey(getTimelineItemForElement(a));
    const bKey = getTimelineItemSortKey(getTimelineItemForElement(b));
    return (aKey.x - bKey.x) || (aKey.y - bKey.y);
}

function getSavedTranscriptElements() {
    return [...document.querySelectorAll('div.vis-item-content')]
        .filter(el => el.getAttribute('aria-hidden') !== 'true' && isElementVisible(el))
        .sort(compareTranscriptElementsByTimeline);
}

function isRoleComboboxTextarea(el) {
    if (!el || !el.matches || !el.matches('textarea')) return false;
    const role = el.getAttribute('role') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const ariaAutocomplete = el.getAttribute('aria-autocomplete') || '';
    const className = String(el.className || '');

    return role === 'combobox'
        || /select one/i.test(placeholder)
        || ariaAutocomplete === 'list'
        || /MuiAutocomplete-input/i.test(className);
}

function isTranscriptTextarea(el) {
    if (!el || !el.matches || !el.matches('textarea')) return false;
    if (el.closest('#lbh-word-count') || el.closest('#lbsg-toast')) return false;
    if (isRoleComboboxTextarea(el)) return false;
    return true;
}

function isExtensionUiElement(el) {
    return !!(el && el.closest && (el.closest('#lbh-word-count') || el.closest('#lbsg-toast') || el.closest('#lbh-reference-modal')));
}

function isTranscriptDisplayTextarea(el) {
    return !!(el && el.matches && el.matches('[data-lbh-selectable]'));
}

function isWidgetNode(node) {
    const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest('#lbh-word-count'));
}

function getLiveTranscriptTextareas() {
    return [...document.querySelectorAll('textarea')]
        .filter(el => el.getAttribute('aria-hidden') !== 'true' && isElementVisible(el) && isTranscriptTextarea(el));
}

function getActiveTranscriptTextarea() {
    const active = document.activeElement;
    if (!isTranscriptTextarea(active)) return null;
    if (active.getAttribute('aria-hidden') === 'true' || !isElementVisible(active)) return null;
    return active;
}

function normalizeSpeakerRole(role) {
    const value = String(role || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b-\u200f\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\*+$/, '')
        .trim();

    if (!value) return '';
    if (!/[A-Za-z0-9]/.test(value)) return '';
    if (value.length > 50 || value.split(/\s+/).length > 5) return '';
    if (/[?]/.test(value)) return '';
    if (/^\d+$/.test(value)) return '';
    if (/^(select|choose|none|n\/a|global classifications|sub-class|what is|how many speakers|data|data rows|overview|evaluation|performance|issues|notifications|settings|start)$/i.test(value)) return '';
    return value;
}

function getElementReadableText(el) {
    if (!el) return '';
    const tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (tag === 'select') {
        const selected = el.selectedOptions && el.selectedOptions[0];
        return selected ? (selected.textContent || selected.value || '') : (el.value || '');
    }

    if (tag === 'input' || tag === 'textarea') {
        return el.value || el.textContent || el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    }

    return el.innerText || el.textContent || el.getAttribute('aria-label') || '';
}

function getRoleQuestionSpeakerNumbers() {
    const seen = new Set();
    const speakers = [];
    const lines = String(document.body?.innerText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    lines.forEach(line => {
        const match = line.match(/what\s+is\s+the\s+role\s+for\s+speaker\s*(\d+)/i);
        if (!match) return;

        const speakerNumber = parseInt(match[1], 10);
        if (!Number.isFinite(speakerNumber) || seen.has(speakerNumber)) return;

        seen.add(speakerNumber);
        speakers.push(speakerNumber);
    });

    return speakers;
}

function getRoleQuestionAnchors() {
    const anchors = [];
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                return /what\s+is\s+the\s+role\s+for\s+speaker\s*\d+/i.test(node.nodeValue || '')
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        }
    );

    let node;
    while ((node = walker.nextNode())) {
        const match = String(node.nodeValue || '').match(/what\s+is\s+the\s+role\s+for\s+speaker\s*(\d+)/i);
        if (!match) continue;

        let el = node.parentElement;
        while (el && el !== document.body) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                anchors.push({
                    speakerNumber: parseInt(match[1], 10),
                    rect,
                    text: String(node.nodeValue || '').trim()
                });
                break;
            }
            el = el.parentElement;
        }
    }

    return anchors
        .filter(anchor => Number.isFinite(anchor.speakerNumber))
        .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
}

function isRoleValueControl(el) {
    if (!el || !el.matches) return false;
    if (el.closest('#lbh-word-count') || el.closest('#lbsg-toast')) return false;

    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const placeholder = el.getAttribute('placeholder') || '';
    const ariaAutocomplete = el.getAttribute('aria-autocomplete') || '';
    const className = String(el.className || '');
    const role = el.getAttribute('role') || '';

    if (tag === 'select') return true;
    return role === 'combobox'
        || /select one/i.test(placeholder)
        || ariaAutocomplete === 'list'
        || /MuiAutocomplete-input/i.test(className);
}

function getRoleValueControlFromNode(node) {
    const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    if (!el || !el.closest) return null;

    if (isRoleValueControl(el)) return el;
    const control = el.closest('textarea[role="combobox"],input[role="combobox"],textarea.MuiAutocomplete-input,input.MuiAutocomplete-input,select');
    return isRoleValueControl(control) ? control : null;
}

function getRoleValueControls() {
    return [...new Set([
        ...document.querySelectorAll('textarea[role="combobox"]'),
        ...document.querySelectorAll('input[role="combobox"]'),
        ...document.querySelectorAll('textarea.MuiAutocomplete-input'),
        ...document.querySelectorAll('input.MuiAutocomplete-input'),
        ...document.querySelectorAll('select')
    ])]
        .filter(el => isElementVisible(el) && isRoleValueControl(el))
        .map(el => {
            const role = normalizeSpeakerRole(getElementReadableText(el));
            const rect = el.getBoundingClientRect();
            return { el, role, rect };
        })
        .filter(item => item.role);
}

function getVisibleRoleScanElements() {
    const selectors = [
        'select',
        'input',
        'textarea',
        '[role="combobox"]',
        '[aria-haspopup="listbox"]',
        '[aria-label*="speaker" i]',
        '[aria-label*="role" i]'
    ];
    return [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
        .filter(el => isElementVisible(el))
        .slice(0, 200);
}

function addRoleAssignmentsFromControls(roleMap) {
    const elements = getVisibleRoleScanElements();

    elements.forEach((el, index) => {
        const questionText = getElementReadableText(el)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!questionText || questionText.length > 180) return;

        const match = questionText.match(/what\s+is\s+the\s+role\s+for\s+speaker\s*(\d+)/i);
        if (!match) return;

        const speakerNumber = parseInt(match[1], 10);
        const inlineRole = getInlineRoleFromRoleQuestion(questionText);
        if (inlineRole) {
            roleMap.set(speakerNumber, inlineRole);
            return;
        }

        for (let j = index + 1; j < Math.min(elements.length, index + 80); j += 1) {
            const candidateText = getElementReadableText(elements[j])
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!candidateText) continue;

            const nextQuestion = candidateText.match(/what\s+is\s+the\s+role\s+for\s+speaker\s*(\d+)/i);
            if (nextQuestion && parseInt(nextQuestion[1], 10) !== speakerNumber) break;
            if (nextQuestion) continue;
            if (/how\s+many\s+speakers\s+are\s+there/i.test(candidateText)) break;
            if (/^(global classifications|sub-class|speaker\s+\d+)$/i.test(candidateText)) continue;

            const role = normalizeSpeakerRole(candidateText);
            if (role) {
                roleMap.set(speakerNumber, role);
                break;
            }
        }
    });
}

function addRoleAssignmentsFromRoleValueControls(roleMap) {
    const speakerNumbers = getRoleQuestionSpeakerNumbers();
    if (speakerNumbers.length === 0) return;

    const roleControls = getRoleValueControls();
    const anchors = getRoleQuestionAnchors();

    if (anchors.length > 0) {
        anchors.forEach((anchor, index) => {
            const nextAnchorTop = anchors[index + 1] ? anchors[index + 1].rect.top : Number.POSITIVE_INFINITY;
            const match = roleControls
                .filter(item => item.rect.top >= anchor.rect.top - 4)
                .filter(item => item.rect.top < Math.min(nextAnchorTop, anchor.rect.top + 180))
                .sort((a, b) => {
                    const aDistance = Math.abs(a.rect.top - anchor.rect.bottom) + Math.abs(a.rect.left - anchor.rect.left) * 0.1;
                    const bDistance = Math.abs(b.rect.top - anchor.rect.bottom) + Math.abs(b.rect.left - anchor.rect.left) * 0.1;
                    return aDistance - bDistance;
                })[0];

            if (match) roleMap.set(anchor.speakerNumber, match.role);
        });

        return;
    }

    speakerNumbers.forEach((speakerNumber, index) => {
        if (roleMap.has(speakerNumber)) return;
        const match = roleControls[index];
        if (match) roleMap.set(speakerNumber, match.role);
    });
}

function getInlineRoleFromRoleQuestion(line) {
    const tail = String(line || '')
        .replace(/^.*?what\s+is\s+the\s+role\s+for\s+speaker\s*\d+\s*\??\s*\*?/i, '')
        .replace(/^\s*\d+\s*/, '')
        .trim();

    if (!tail || /what\s+is\s+the\s+role\s+for\s+speaker/i.test(tail)) return '';
    return normalizeSpeakerRole(tail);
}

function addRoleAssignmentsFromPageText(roleMap) {
    const lines = String(document.body?.innerText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (let i = 0; i < lines.length; i += 1) {
        const match = lines[i].match(/what\s+is\s+the\s+role\s+for\s+speaker\s*(\d+)/i);
        if (!match) continue;

        const speakerNumber = parseInt(match[1], 10);
        if (roleMap.has(speakerNumber)) continue;

        const inlineRole = getInlineRoleFromRoleQuestion(lines[i]);
        if (inlineRole) {
            roleMap.set(speakerNumber, inlineRole);
            continue;
        }

        for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
            if (/what\s+is\s+the\s+role\s+for\s+speaker/i.test(lines[j])) break;
            if (/how\s+many\s+speakers\s+are\s+there/i.test(lines[j])) break;

            const role = normalizeSpeakerRole(lines[j]);
            if (role) {
                roleMap.set(speakerNumber, role);
                break;
            }
        }
    }
}

function getSpeakerRoleAssignments(force = false) {
    const now = Date.now();
    const rowKey = getCurrentDataRowKey();
    if (
        !force
        && speakerRoleAssignmentsCache.rowKey === rowKey
        && now - speakerRoleAssignmentsCache.at < ROLE_ASSIGNMENTS_CACHE_MS
    ) {
        return new Map(speakerRoleAssignmentsCache.map);
    }

    const roleMap = new Map();
    addRoleAssignmentsFromPageText(roleMap);
    addRoleAssignmentsFromControls(roleMap);
    addRoleAssignmentsFromRoleValueControls(roleMap);

    speakerRoleAssignmentsCache = { rowKey, at: now, map: new Map(roleMap) };

    return new Map(roleMap);
}

function getVisibleTranscriptTimelineItems(extraItems = [], savedElements = null) {
    const items = new Set(extraItems.filter(Boolean));
    (savedElements || getSavedTranscriptElements()).forEach(el => items.add(getTimelineItemForElement(el)));
    getLiveTranscriptTextareas().forEach(el => items.add(getTimelineItemForElement(el)));
    return [...items].filter(item => item && isElementVisible(item));
}

function getSpeakerNumbersForTimelineItems(items) {
    const itemToRow = new Map();

    // Build a map from each .vis-group element to its ACTUAL speaker number by
    // reading the sidebar labels (.vis-label elements in .vis-labelset).
    // The labels and groups are rendered in the same top-to-bottom DOM order,
    // so label[i] corresponds to group[i]. The label text is e.g. "Speaker 2"
    // or just "2" — we parse the number from it directly instead of assuming
    // visual row order equals speaker number order.
    const groupToSpeakerNumber = new Map();

    const groups = [...document.querySelectorAll('.vis-foreground .vis-group')];
    const labels = [...document.querySelectorAll('.vis-labelset .vis-label')];

    if (groups.length > 0) {
        groups.forEach((group, index) => {
            const label = labels[index];
            const labelText = label ? (label.innerText || label.textContent || '').trim() : '';
            // Try to parse a speaker number from the label, e.g. "Speaker 2" → 2
            const match = labelText.match(/(\d+)/);
            if (match) {
                groupToSpeakerNumber.set(group, parseInt(match[1], 10));
            } else {
                // Label has no number (e.g. a named speaker) — fall back to 1-based index
                groupToSpeakerNumber.set(group, index + 1);
            }
        });
    }

    const hasGroups = groupToSpeakerNumber.size > 0;
    const unmapped = [];

    items.forEach(item => {
        if (!item) return;
        const group = item.closest('.vis-group');
        if (hasGroups && group && groupToSpeakerNumber.has(group)) {
            itemToRow.set(item, groupToSpeakerNumber.get(group));
        } else {
            unmapped.push(item);
        }
    });

    // Fallback for flat/single-row layouts where .vis-group elements don't exist.
    if (unmapped.length > 0) {
        const rows = [];
        const tolerancePx = 8;

        unmapped.forEach(item => {
            const rect = item.getBoundingClientRect();
            const topCandidate = (rect.height > 0) ? (rect.top + rect.height / 2) : item.offsetTop;
            const centerY = Number.isFinite(topCandidate) ? topCandidate : 0;

            let row = rows.find(candidate => Math.abs(candidate.centerY - centerY) <= tolerancePx);
            if (!row) {
                row = { centerY, items: [] };
                rows.push(row);
            } else {
                row.centerY = (row.centerY * row.items.length + centerY) / (row.items.length + 1);
            }
            row.items.push(item);
        });

        rows.sort((a, b) => a.centerY - b.centerY);
        rows.forEach((row, index) => {
            row.items.forEach(item => itemToRow.set(item, index + 1));
        });
    }

    return itemToRow;
}

function getRoleForTimelineItem(item, roleMap, itemSpeakerNumbers) {
    const speakerNumber = itemSpeakerNumbers.get(item);
    return roleMap.get(speakerNumber) || '';
}

function getSavedTranscriptSegments(savedElements = getSavedTranscriptElements()) {
    const roleMap = getSpeakerRoleAssignments();
    const timelineItems = getVisibleTranscriptTimelineItems(savedElements.map(getTimelineItemForElement), savedElements);
    const itemSpeakerNumbers = getSpeakerNumbersForTimelineItems(timelineItems);

    return savedElements.map(el => {
        const item = getTimelineItemForElement(el);
        const speakerNumber = itemSpeakerNumbers.get(item) || null;
        return {
            text: el.textContent || '',
            role: getRoleForTimelineItem(item, roleMap, itemSpeakerNumbers),
            speakerNumber
        };
    });
}

function getTranscriptSpeakerInfoForTextarea(textarea) {
    const roleMap = getSpeakerRoleAssignments();
    const item = getTimelineItemForElement(textarea) || document.querySelector('.vis-item.vis-selected');
    // Use ALL visible timeline items so speaker rank is computed relative to
    // every row — not just the one item being edited (which would always get rank 1).
    const allItems = getVisibleTranscriptTimelineItems([item]);
    const itemSpeakerNumbers = getSpeakerNumbersForTimelineItems(allItems);
    const speakerNumber = itemSpeakerNumbers.get(item) || null;
    return {
        role: getRoleForTimelineItem(item, roleMap, itemSpeakerNumbers),
        speakerNumber
    };
}

function formatTranscriptSegmentForDisplay(segment) {
    return segment.role ? `${segment.role}: ${segment.text}` : segment.text;
}

function buildSnapshotFromSegments(segments) {
    const cleanSegments = segments
        .map(segment => {
            if (segment && typeof segment === 'object') {
                return {
                    text: normalizeSegmentText(segment.text),
                    role: normalizeSpeakerRole(segment.role),
                    speakerNumber: Number.isFinite(segment.speakerNumber) ? segment.speakerNumber : null
                };
            }

            return {
                text: normalizeSegmentText(segment),
                role: '',
                speakerNumber: null
            };
        })
        .filter(segment => segment.text.length > 0);

    if (cleanSegments.length === 0) return null;

    const textSegments = cleanSegments.map(segment => segment.text);
    const displaySegments = cleanSegments.map(formatTranscriptSegmentForDisplay);
    const text = textSegments.join('\n');
    const displayText = displaySegments.join('\n');

    return {
        segments: textSegments,
        roles: cleanSegments.map(segment => segment.role),
        speakerNumbers: cleanSegments.map(segment => segment.speakerNumber),
        displaySegments,
        text,
        displayText,
        segmentCount: cleanSegments.length,
        wordCount: countWordsInText(text),
        charCount: text.length,
        signature: displaySegments.join('\n\u241e')
    };
}

function buildSavedTranscriptSnapshot() {
    return buildSnapshotFromSegments(getSavedTranscriptSegments());
}

function buildLiveTranscriptSnapshot() {
    const savedElements = getSavedTranscriptElements();
    const savedSegments = getSavedTranscriptSegments(savedElements);
    const activeTextarea = getActiveTranscriptTextarea();

    if (savedSegments.length > 0) {
        const mergedSegments = savedSegments.map(segment => ({
            text: normalizeSegmentText(segment.text),
            role: normalizeSpeakerRole(segment.role),
            speakerNumber: Number.isFinite(segment.speakerNumber) ? segment.speakerNumber : null
        }));
        if (activeTextarea) {
            const liveText = normalizeSegmentText(activeTextarea.value || '');
            const selectedContent = document.querySelector('.vis-item.vis-selected div.vis-item-content')
                || document.querySelector('.vis-item.vis-selected [aria-hidden="false"].vis-item-content')
                || document.querySelector('.vis-item.vis-selected .vis-item-content');
            const selectedIndex = selectedContent ? savedElements.indexOf(selectedContent) : -1;

            if (liveText) {
                const savedText = selectedIndex >= 0 ? normalizeSegmentText(mergedSegments[selectedIndex].text) : '';
                const looksLikeEditorPlaceholder = /^\d{1,2}$/.test(liveText) && savedText && savedText !== liveText;
                if (looksLikeEditorPlaceholder) {
                    return buildSnapshotFromSegments(mergedSegments);
                }
                if (selectedIndex >= 0) {
                    mergedSegments[selectedIndex] = {
                        ...mergedSegments[selectedIndex],
                        text: liveText
                    };
                } else if (mergedSegments.length === 1) {
                    mergedSegments[0] = {
                        ...mergedSegments[0],
                        text: liveText
                    };
                }
            }
        }
        return buildSnapshotFromSegments(mergedSegments);
    }

    if (!activeTextarea) return null;
    const activeText = normalizeSegmentText(activeTextarea.value || '');
    if (/^\d{1,2}$/.test(activeText)) return null;
    const speakerInfo = getTranscriptSpeakerInfoForTextarea(activeTextarea);
    return buildSnapshotFromSegments([{
        text: activeText,
        role: speakerInfo.role,
        speakerNumber: speakerInfo.speakerNumber
    }]);
}

function getTranscriptTokens(text, preserveCase = false) {
    const matches = String(text || '').match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g) || [];
    return preserveCase ? matches : matches.map(token => token.toLowerCase());
}

function levenshteinDistance(source, target) {
    const a = Array.isArray(source) ? source : [];
    const b = Array.isArray(target) ? target : [];
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

    for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
    for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[a.length][b.length];
}

function toAccuracyPct(total, errors) {
    if (total <= 0) return 100;
    return Math.max(0, ((total - errors) / total) * 100);
}

function computeTranscriptionMetrics(beforeSnapshot, afterSnapshot) {
    if (!beforeSnapshot || !afterSnapshot) return null;

    // Accuracy is calculated from raw segment text only; role labels are display-only.
    const beforeAccuracyText = (beforeSnapshot.segments || []).join('\n') || beforeSnapshot.text || '';
    const afterAccuracyText = (afterSnapshot.segments || []).join('\n') || afterSnapshot.text || '';
    const beforeWordTokens = getTranscriptTokens(beforeAccuracyText);
    const afterWordTokens = getTranscriptTokens(afterAccuracyText);
    const beforeExactTokens = getTranscriptTokens(beforeAccuracyText, true);
    const afterExactTokens = getTranscriptTokens(afterAccuracyText, true);

    const wordChanges = levenshteinDistance(beforeWordTokens, afterWordTokens);
    const exactChanges = levenshteinDistance(beforeExactTokens, afterExactTokens);
    const formattingChanges = Math.max(0, exactChanges - wordChanges);
    const baseWordCount = beforeWordTokens.length;

    return {
        baseWordCount,
        finalWordCount: afterWordTokens.length,
        wordChanges,
        formattingChanges,
        totalAccuracyPct: toAccuracyPct(baseWordCount, exactChanges),
        formatAccuracyPct: toAccuracyPct(baseWordCount, formattingChanges)
    };
}

function cloneTranscriptSnapshot(snapshot) {
    if (!snapshot) return null;
    return {
        segments: [...(snapshot.segments || [])],
        roles: [...(snapshot.roles || [])],
        speakerNumbers: [...(snapshot.speakerNumbers || [])],
        displaySegments: [...(snapshot.displaySegments || snapshot.segments || [])],
        text: snapshot.text,
        displayText: snapshot.displayText || snapshot.text,
        segmentCount: snapshot.segmentCount,
        wordCount: snapshot.wordCount,
        charCount: snapshot.charCount,
        signature: snapshot.signature
    };
}

function applyCurrentRoleAssignmentsToSnapshot(snapshot) {
    if (!snapshot || !snapshot.speakerNumbers || !snapshot.speakerNumbers.some(Number.isFinite)) return snapshot;

    const roleMap = getSpeakerRoleAssignments();
    if (roleMap.size === 0) return snapshot;

    const segments = snapshot.segments.map((text, index) => {
        const speakerNumber = snapshot.speakerNumbers[index];
        return {
            text,
            role: roleMap.get(speakerNumber) || (snapshot.roles ? snapshot.roles[index] : ''),
            speakerNumber
        };
    });

    return buildSnapshotFromSegments(segments) || snapshot;
}

function snapshotNeedsMissingRoleBackfill(snapshot) {
    if (!snapshot || !snapshot.speakerNumbers || !snapshot.segments) return false;
    return snapshot.speakerNumbers.some((speakerNumber, index) => (
        Number.isFinite(speakerNumber)
        && !normalizeSpeakerRole(snapshot.roles ? snapshot.roles[index] : '')
    ));
}

function fillMissingRoleAssignmentsInSnapshot(snapshot) {
    if (!snapshotNeedsMissingRoleBackfill(snapshot)) return snapshot;

    const roleMap = getSpeakerRoleAssignments();
    if (roleMap.size === 0) return snapshot;

    const segments = snapshot.segments.map((text, index) => {
        const speakerNumber = snapshot.speakerNumbers[index];
        const existingRole = normalizeSpeakerRole(snapshot.roles ? snapshot.roles[index] : '');
        return {
            text,
            role: existingRole || roleMap.get(speakerNumber) || '',
            speakerNumber
        };
    });

    return buildSnapshotFromSegments(segments) || snapshot;
}

function choosePreferredSnapshot(localSnapshot, childSnapshot) {
    if (!localSnapshot) return childSnapshot ? cloneTranscriptSnapshot(childSnapshot) : null;
    if (!childSnapshot) return localSnapshot;

    if (childSnapshot.segmentCount > localSnapshot.segmentCount) {
        return cloneTranscriptSnapshot(childSnapshot);
    }
    if (childSnapshot.segmentCount === localSnapshot.segmentCount && childSnapshot.charCount > localSnapshot.charCount) {
        return cloneTranscriptSnapshot(childSnapshot);
    }
    return localSnapshot;
}

function getPreferredSavedTranscriptSnapshot() {
    const local = buildSavedTranscriptSnapshot();
    const child = childFrameTranscript.savedSnapshot;
    // Only apply local role assignments to a locally-built snapshot.
    // If we pick the child snapshot, its speakerNumbers are row indices
    // from the child frame's timeline — applying the parent's roleMap would
    // assign the wrong speaker roles.
    if (!local) return child ? cloneTranscriptSnapshot(child) : null;
    const localWithRoles = applyCurrentRoleAssignmentsToSnapshot(local);
    if (!child) return localWithRoles;
    if (child.segmentCount > local.segmentCount) return cloneTranscriptSnapshot(child);
    if (child.segmentCount === local.segmentCount && child.charCount > local.charCount) return cloneTranscriptSnapshot(child);
    return localWithRoles;
}

function getPreferredLiveTranscriptSnapshot() {
    const local = buildLiveTranscriptSnapshot();
    const child = childFrameTranscript.liveSnapshot;
    // Same reasoning as getPreferredSavedTranscriptSnapshot above.
    if (!local) return child ? cloneTranscriptSnapshot(child) : null;
    const localWithRoles = applyCurrentRoleAssignmentsToSnapshot(local);
    if (!child) return localWithRoles;
    if (child.segmentCount > local.segmentCount) return cloneTranscriptSnapshot(child);
    if (child.segmentCount === local.segmentCount && child.charCount > local.charCount) return cloneTranscriptSnapshot(child);
    return localWithRoles;
}

function persistTranscriptionCapture() {
    if (!isTopFrame()) return;

    const payload = transcriptionCapture.before || transcriptionCapture.after
        ? {
            rowKey: transcriptionCapture.rowKey,
            before: transcriptionCapture.before ? {
                segments: [...transcriptionCapture.before.segments],
                roles: [...(transcriptionCapture.before.roles || [])],
                speakerNumbers: [...(transcriptionCapture.before.speakerNumbers || [])],
                displaySegments: [...(transcriptionCapture.before.displaySegments || transcriptionCapture.before.segments)],
                text: transcriptionCapture.before.text,
                displayText: transcriptionCapture.before.displayText || transcriptionCapture.before.text,
                segmentCount: transcriptionCapture.before.segmentCount,
                wordCount: transcriptionCapture.before.wordCount
            } : null,
            after: transcriptionCapture.after ? {
                segments: [...transcriptionCapture.after.segments],
                roles: [...(transcriptionCapture.after.roles || [])],
                speakerNumbers: [...(transcriptionCapture.after.speakerNumbers || [])],
                displaySegments: [...(transcriptionCapture.after.displaySegments || transcriptionCapture.after.segments)],
                text: transcriptionCapture.after.text,
                displayText: transcriptionCapture.after.displayText || transcriptionCapture.after.text,
                segmentCount: transcriptionCapture.after.segmentCount,
                wordCount: transcriptionCapture.after.wordCount
            } : null,
            metrics: transcriptionCapture.metrics ? { ...transcriptionCapture.metrics } : null
        }
        : null;

    const signature = JSON.stringify(payload);
    if (signature === lastSavedTranscriptionSignature) return;
    lastSavedTranscriptionSignature = signature;

    chrome.storage.local.set({ _lbhTranscriptionCapture: payload });
}

function updateTranscriptionCapture() {
    const rowKey = getCurrentDataRowKey();
    if (transcriptionCapture.rowKey !== rowKey) {
        transcriptionCapture = { rowKey, before: null, after: null, metrics: null };
        childFrameTranscript = { rowKey: '', savedSnapshot: null, liveSnapshot: null };
        lastSavedTranscriptionSignature = '';
    }

    const beforeSnapshot = getPreferredSavedTranscriptSnapshot();
    const afterSnapshot = getPreferredLiveTranscriptSnapshot() || beforeSnapshot;

    if (!beforeSnapshot && !afterSnapshot) {
        persistTranscriptionCapture();
        return;
    }

    if (!transcriptionCapture.before && beforeSnapshot) {
        transcriptionCapture.before = cloneTranscriptSnapshot(beforeSnapshot);
    } else if (snapshotNeedsMissingRoleBackfill(transcriptionCapture.before)) {
        transcriptionCapture.before = cloneTranscriptSnapshot(
            fillMissingRoleAssignmentsInSnapshot(transcriptionCapture.before)
        );
    }

    transcriptionCapture.after = afterSnapshot ? cloneTranscriptSnapshot(afterSnapshot) : null;
    transcriptionCapture.metrics = transcriptionCapture.before && transcriptionCapture.after
        ? computeTranscriptionMetrics(transcriptionCapture.before, transcriptionCapture.after)
        : null;

    persistTranscriptionCapture();
}

function formatDuration(ms) {
    if (!ms || ms <= 0) return '0:00.00';
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = (totalSec % 60).toFixed(2).padStart(5, '0');
    return `${String(m).padStart(2, '0')}:${s}`;
}

let cachedTotalMediaMs = 0;

function getTotalMediaMs() {
    const timeEl = document.querySelector('[data-cy="editable-audio-time"]');
    if (!timeEl) return cachedTotalMediaMs;
    const parts = (timeEl.textContent || '').split('/');
    if (parts.length < 2) return cachedTotalMediaMs;
    const durMatch = parts[parts.length - 1].trim().match(/(\d+):(\d+)\.(\d+)/);
    if (!durMatch) return cachedTotalMediaMs;
    cachedTotalMediaMs =
        parseInt(durMatch[1], 10) * 60000 +
        parseInt(durMatch[2], 10) * 1000 +
        parseInt(durMatch[3], 10);
    return cachedTotalMediaMs;
}

function getTimelineContainer() {
    const items = document.querySelectorAll('.vis-item');
    if (items.length === 0) return null;
    const candidates = ['.vis-foreground', '.vis-itemset', '.vis-content', '.vis-panel.vis-center', '.vis-panel'];
    for (const sel of candidates) {
        const c = items[0].closest(sel);
        if (c && c.getBoundingClientRect().width >= 80) return c;
    }
    let el = items[0].parentElement;
    while (el && el.getBoundingClientRect().width < 80) el = el.parentElement;
    return el || null;
}

function getSegmentTotalMs() {
    const totalMediaMs = getTotalMediaMs();
    if (totalMediaMs <= 0) return 0;

    const container = getTimelineContainer();
    const containerWidth = container ? container.getBoundingClientRect().width : 0;
    if (containerWidth < 80) return 0;

    const msPerPx = totalMediaMs / containerWidth;
    let totalMs = 0;
    document.querySelectorAll('.vis-item').forEach(item => {
        const wMatch = item.style.width && item.style.width.match(/([\d.]+)px/);
        if (!wMatch) return;
        totalMs += parseFloat(wMatch[1]) * msPerPx;
    });

    return Math.min(totalMediaMs, Math.max(0, totalMs));
}

function mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged = [[sorted[0][0], sorted[0][1]]];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i][0] <= last[1]) {
            last[1] = Math.max(last[1], sorted[i][1]);
        } else {
            merged.push([sorted[i][0], sorted[i][1]]);
        }
    }
    return merged;
}

function sumRanges(ranges) {
    return ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
}

// Like getSegmentTotalMs but merges overlapping segments so duplicate
// speaker assignments don't inflate the total.
function getDeduplicatedTtMs() {
    const totalMediaMs = getTotalMediaMs();
    if (totalMediaMs <= 0) return 0;

    const container = getTimelineContainer();
    const containerWidth = container ? container.getBoundingClientRect().width : 0;
    if (containerWidth < 80) return 0;

    const msPerPx = totalMediaMs / containerWidth;
    const ranges = [];

    document.querySelectorAll('.vis-item').forEach(item => {
        // Items are positioned with transform: translateX(Xpx)
        const txMatch = item.style.transform && item.style.transform.match(/translateX\(([\d.]+)px\)/);
        const wMatch  = item.style.width && item.style.width.match(/([\d.]+)px/);
        if (!txMatch || !wMatch) return;
        const startMs = parseFloat(txMatch[1]) * msPerPx;
        const endMs   = startMs + parseFloat(wMatch[1]) * msPerPx;
        ranges.push([startMs, endMs]);
    });

    return Math.min(totalMediaMs, sumRanges(mergeRanges(ranges)));
}


function applyWidgetPosition(widget, x, y) {
    // Clamp so it never goes off-screen
    const maxX = window.innerWidth - widget.offsetWidth - 4;
    const maxY = window.innerHeight - widget.offsetHeight - 4;
    const cx = Math.max(4, Math.min(x, maxX));
    const cy = Math.max(4, Math.min(y, maxY));
    widget.style.left = `${cx}px`;
    widget.style.top = `${cy}px`;
    widget.style.bottom = 'auto';
}

function clampWidgetExpandedSize(width, height) {
    const maxWidth = Math.max(WIDGET_COLLAPSED_WIDTH_PX, window.innerWidth - 24);
    const maxHeight = Math.max(220, window.innerHeight - 24);

    return {
        width: Math.max(WIDGET_COLLAPSED_WIDTH_PX, Math.min(Number(width) || WIDGET_EXPANDED_DEFAULT_WIDTH_PX, maxWidth)),
        height: Math.max(260, Math.min(Number(height) || WIDGET_EXPANDED_DEFAULT_HEIGHT_PX, maxHeight))
    };
}

function persistWidgetExpandedSize(widget) {
    if (!widget || !transcriptPanelExpanded) return;
    const rect = widget.getBoundingClientRect();
    const size = clampWidgetExpandedSize(rect.width, rect.height);
    widgetExpandedSize = size;
    chrome.storage.local.set({
        _lbhWidgetExpandedWidth: size.width,
        _lbhWidgetExpandedHeight: size.height
    });
}

function applyWidgetSizeMode(widget) {
    if (!widget || widget.dataset.lbhResizing === 'true') return;

    if (!transcriptPanelExpanded) {
        widget.style.resize = 'none';
        widget.style.width = `${WIDGET_COLLAPSED_WIDTH_PX}px`;
        widget.style.height = 'auto';
        widget.style.minHeight = '0';
        widget.style.maxHeight = 'min(80vh, calc(100vh - 24px))';
        return;
    }

    const size = clampWidgetExpandedSize(widgetExpandedSize.width, widgetExpandedSize.height);
    widget.style.resize = 'both';
    widget.style.width = `${size.width}px`;
    widget.style.height = `${size.height}px`;
    widget.style.minHeight = '260px';
    widget.style.maxHeight = 'calc(100vh - 24px)';

    if (document.body.contains(widget)) {
        const rect = widget.getBoundingClientRect();
        applyWidgetPosition(widget, rect.left, rect.top);
    }
}

function makeDraggable(widget) {
    let dragging = false;
    let resizing = false;
    let didMove = false;
    let pressTarget = null;
    let originX = 0;
    let originY = 0;
    let startLeft = 0;
    let startTop = 0;

    widget.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (closestFromEventTarget(e.target, '[data-lbh-close]')) return;
        if (isWidgetResizeHandlePress(widget, e)) {
            resizing = true;
            widget.dataset.lbhResizing = 'true';
            suppressNextWidgetToggle(widget, 700);
            return;
        }
        if (closestFromEventTarget(e.target, '[data-lbh-nodrag]')) return;
        dragging = true;
        didMove = false;
        pressTarget = e.target;
        originX = e.clientX;
        originY = e.clientY;
        const rect = widget.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        widget.style.transition = 'none';
        widget.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        if (Math.abs(e.clientX - originX) > 3 || Math.abs(e.clientY - originY) > 3) {
            didMove = true;
        }
        const x = startLeft + (e.clientX - originX);
        const y = startTop + (e.clientY - originY);
        applyWidgetPosition(widget, x, y);
    });

    document.addEventListener('mouseup', e => {
        if (resizing) {
            resizing = false;
            delete widget.dataset.lbhResizing;
            persistWidgetExpandedSize(widget);
            suppressNextWidgetToggle(widget);
            return;
        }

        if (!dragging) return;
        const shouldToggle = !didMove && shouldToggleTranscriptFromWidgetTarget(pressTarget, widget, e.clientX, e.clientY, false);
        dragging = false;
        pressTarget = null;
        widget.style.userSelect = '';
        // Persist position so it survives page reloads
        const rect = widget.getBoundingClientRect();
        chrome.storage.local.set({ _lbhWidgetX: rect.left, _lbhWidgetY: rect.top });
        if (shouldToggle) {
            suppressNextWidgetToggle(widget);
            toggleTranscriptPanel();
        } else if (didMove) {
            suppressNextWidgetToggle(widget);
        }
    });
}

function shouldToggleTranscriptFromWidgetTarget(target, widget, clientX, clientY, respectSkip = true) {
    if (!widget || (respectSkip && widget.dataset.lbhSkipToggleClick === 'true')) return false;
    if (isWidgetResizeHandlePress(widget, { clientX, clientY })) {
        suppressNextWidgetToggle(widget);
        return false;
    }
    if (closestFromEventTarget(target, '[data-lbh-action]')) return false;
    if (closestFromEventTarget(target, '[data-lbh-close]')) return false;
    if (closestFromEventTarget(target, '[data-lbh-selectable]')) return false;
    if (closestFromEventTarget(target, 'button,input,textarea,select,a,[contenteditable="true"]')) return false;

    const selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed) return false;

    return true;
}

function shouldToggleTranscriptFromWidgetClick(e, widget) {
    return shouldToggleTranscriptFromWidgetTarget(e.target, widget, e.clientX, e.clientY);
}

function protectTranscriptTextareaEvents(widget) {
    if (!widget) return;

    widget.querySelectorAll('[data-lbh-selectable]').forEach(textarea => {
        if (textarea.dataset.lbhProtected === 'true') return;
        textarea.dataset.lbhProtected = 'true';

        ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'selectstart'].forEach(type => {
            textarea.addEventListener(type, e => {
                e.stopPropagation();
            });
        });

        textarea.addEventListener('wheel', e => {
            e.stopPropagation();
        }, { passive: true });
    });
}

function ensureWordCountWidget() {
    if (wordCountWidget && document.body.contains(wordCountWidget)) return wordCountWidget;

    wordCountWidget = document.createElement('div');
    wordCountWidget.id = 'lbh-word-count';
    wordCountWidget.style.cssText = [
        'position:fixed',
        'bottom:16px',
        'left:16px',
        'z-index:2147483647',
        'background:#161b22',
        'color:#ffffff',
        'border:1px solid #2a3240',
        'border-radius:6px',
        'padding:8px 12px',
        'font-family:"Segoe UI",Tahoma,sans-serif',
        'font-size:14px',
        'pointer-events:auto',
        'cursor:grab',
        'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
        'line-height:1.4',
        'user-select:auto',
        `width:${WIDGET_COLLAPSED_WIDTH_PX}px`,
        'min-width:260px',
        'min-height:0',
        'max-width:calc(100vw - 24px)',
        'max-height:min(80vh, calc(100vh - 24px))',
        'box-sizing:border-box',
        'resize:none',
        'overflow:auto'
    ].join(';');

    makeDraggable(wordCountWidget);

    wordCountWidget.addEventListener('pointerdown', e => {
        if (closestFromEventTarget(e.target, '[data-lbh-selectable]')) return;
        handleWidgetActionPress(e);
    }, true);
    wordCountWidget.addEventListener('mousedown', e => {
        if (handleWidgetActionPress(e)) return;
        if (closestFromEventTarget(e.target, '[data-lbh-selectable]')) return;

        if (closestFromEventTarget(e.target, '[data-lbh-nodrag]')) {
            e.stopImmediatePropagation();
        }
    }, true);
    wordCountWidget.addEventListener('click', e => {
        if (suppressWidgetActionClick(e)) return;
        if (closestFromEventTarget(e.target, '[data-lbh-selectable]')) return;
        if (shouldToggleTranscriptFromWidgetClick(e, wordCountWidget)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleTranscriptPanel();
            return;
        }
        if (closestFromEventTarget(e.target, '[data-lbh-nodrag]')) {
            e.stopImmediatePropagation();
        }
    }, true);
    wordCountWidget.addEventListener('dblclick', e => {
        if (closestFromEventTarget(e.target, '[data-lbh-selectable]')) return;
    }, true);
    wordCountWidget.addEventListener('selectstart', e => {
        if (closestFromEventTarget(e.target, '[data-lbh-selectable]')) return;
    }, true);
    wordCountWidget.addEventListener('wheel', e => {
        if (closestFromEventTarget(e.target, '[data-lbh-selectable]')) return;
    }, { capture: true, passive: true });

    wordCountWidget.addEventListener('mouseover', e => {
        const closeButton = closestFromEventTarget(e.target, '[data-lbh-close]');
        if (closeButton) closeButton.style.color = '#ffffff';
    });
    wordCountWidget.addEventListener('mouseout', e => {
        const closeButton = closestFromEventTarget(e.target, '[data-lbh-close]');
        if (closeButton) closeButton.style.color = '#e5e7eb';
    });

    // Restore saved position if available
    chrome.storage.local.get([
        '_lbhWidgetX',
        '_lbhWidgetY',
        '_lbhWidgetExpandedWidth',
        '_lbhWidgetExpandedHeight'
    ], saved => {
        widgetExpandedSize = clampWidgetExpandedSize(saved._lbhWidgetExpandedWidth, saved._lbhWidgetExpandedHeight);
        applyWidgetSizeMode(wordCountWidget);

        if (saved._lbhWidgetX !== undefined && saved._lbhWidgetY !== undefined) {
            applyWidgetPosition(wordCountWidget, saved._lbhWidgetX, saved._lbhWidgetY);
        }
    });

    document.body.appendChild(wordCountWidget);
    return wordCountWidget;
}

function isTopFrame() {
    try { return window.self === window.top; } catch (e) { return false; }
}

// Latest word count reported by any child frame — overwritten on every message, never accumulated
let childFrameCount = { words: 0, segments: 0, totalMs: 0, containerWidth: 0, deduplicatedTtMs: 0 };
// Talk time extracted from timestamp text in child frames (-1 = not yet received)
let childFrameTtMs = -1;

function getLocalCounts() {
    let targets = [...document.querySelectorAll('div.vis-item-content')]
        .filter(el => el.getAttribute('aria-hidden') !== 'true');
    if (targets.length === 0) {
        targets = [...document.querySelectorAll('textarea')]
            .filter(el => el.getAttribute('aria-hidden') !== 'true');
    }
    let words = 0;
    let segments = 0;
    targets.forEach(el => {
        if (isTranscriptDisplayTextarea(el)) return;
        const text = el.value || el.textContent || '';
        if (!text.trim()) return;
        words += countWordsInText(text);
        segments += 1;
    });
    const totalMs = getSegmentTotalMs();
    return { words, segments, totalMs };
}

function parseTsToMs(min, sec) {
    return parseInt(min, 10) * 60000 + Math.round(parseFloat(sec) * 1000);
}

// Scans the current frame's text for [MM:SS.mmm - MM:SS.mmm] timestamp ranges
// and returns the sum of all segment durations in ms, or -1 if none found.
function extractTtMsFromTimestamps() {
    if (!document.body) return -1;
    const text = document.body.innerText || '';
    const pattern = /\[(\d+):(\d+\.\d+)\s*-\s*(\d+):(\d+\.\d+)\]/g;
    let totalMs = 0;
    let found = false;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        found = true;
        const start = parseTsToMs(match[1], match[2]);
        const end = parseTsToMs(match[3], match[4]);
        if (end > start) totalMs += end - start;
    }
    return found ? totalMs : -1;
}

function getTranscriptTextForCopy(side) {
    const snapshot = side === 'before' ? transcriptionCapture.before : transcriptionCapture.after;
    return (snapshot ? (snapshot.displayText || snapshot.text || '') : '').trim();
}

function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        document.execCommand('copy');
    } finally {
        textarea.remove();
    }
}

async function writeTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    fallbackCopyText(text);
}

function markTranscriptCopied(side) {
    if (transcriptCopyStatus.timer) clearTimeout(transcriptCopyStatus.timer);
    transcriptCopyStatus = {
        side,
        at: Date.now(),
        timer: setTimeout(() => {
            if (transcriptCopyStatus.side === side) {
                transcriptCopyStatus = { side: '', at: 0, timer: null };
                if (settings.enabled) updateWordCount();
            }
        }, 1200)
    };
    if (settings.enabled) updateWordCount();
}

async function copyTranscriptSection(side) {
    const text = getTranscriptTextForCopy(side);
    if (!text) return;

    try {
        await writeTextToClipboard(text);
        markTranscriptCopied(side);
    } catch (_) {
        fallbackCopyText(text);
        markTranscriptCopied(side);
    }
}

function renderTranscriptSection(label, text, accentColor, highlightedHtml = '') {
    const hasText = !!text;
    const textareaText = hasText ? text : 'Waiting for transcription capture...';
    const side = label.toLowerCase();
    const canCopy = side === 'before' || side === 'after';
    const copied = canCopy && transcriptCopyStatus.side === side && Date.now() - transcriptCopyStatus.at < 1200;
    const copyButton = canCopy
        ? `<button data-lbh-nodrag data-lbh-action="copy-${side}" ${hasText ? '' : 'disabled'} style="background:${copied ? '#166534' : '#1e293b'};color:#e5e7eb;border:1px solid ${copied ? '#22c55e' : '#475569'};border-radius:4px;padding:2px 8px;font:inherit;font-size:12px;cursor:${hasText ? 'pointer' : 'not-allowed'};opacity:${hasText ? '1' : '0.55'};">${copied ? 'Copied' : 'Copy'}</button>`
        : '';
    return (
        `<div data-lbh-nodrag style="margin-top:8px;">` +
            `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">` +
                `<div style="color:${accentColor};font-weight:600;">${label}</div>` +
                copyButton +
            '</div>' +
            `<div data-lbh-selectable tabindex="0" aria-label="${escapeHtml(label)} transcript" style="display:block;width:100%;height:140px;box-sizing:border-box;background:rgba(15,23,42,0.88);border:1px solid #334155;border-left:4px solid ${accentColor};border-radius:4px;padding:6px 8px;white-space:pre-wrap;overflow:auto;overscroll-behavior:contain;color:${hasText ? '#e5e7eb' : '#94a3b8'};cursor:text;user-select:text;-webkit-user-select:text;font:inherit;line-height:1.4;outline:none;pointer-events:auto;position:relative;z-index:2;touch-action:auto;">${highlightedHtml || escapeHtml(textareaText)}</div>` +
        '</div>'
    );
}

function getTranscriptTokenRanges(text) {
    const tokens = [];
    const regex = /[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g;
    let match;
    while ((match = regex.exec(String(text || ''))) !== null) {
        tokens.push({
            text: match[0],
            lower: match[0].toLowerCase(),
            start: match.index,
            end: match.index + match[0].length
        });
    }
    return tokens;
}

function getLowercaseMatchPairs(beforeTokens, afterTokens) {
    const rows = beforeTokens.length + 1;
    const cols = afterTokens.length + 1;
    const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));

    for (let i = beforeTokens.length - 1; i >= 0; i -= 1) {
        for (let j = afterTokens.length - 1; j >= 0; j -= 1) {
            if (beforeTokens[i].lower === afterTokens[j].lower) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
    }

    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < beforeTokens.length && j < afterTokens.length) {
        if (beforeTokens[i].lower === afterTokens[j].lower) {
            pairs.push([i, j]);
            i += 1;
            j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i += 1;
        } else {
            j += 1;
        }
    }
    return pairs;
}

function buildTranscriptDiffHighlights(beforeText, afterText) {
    const beforeTokens = getTranscriptTokenRanges(beforeText);
    const afterTokens = getTranscriptTokenRanges(afterText);
    const beforeFlags = new Array(beforeTokens.length).fill('');
    const afterFlags = new Array(afterTokens.length).fill('');
    const matchedBefore = new Set();
    const matchedAfter = new Set();

    getLowercaseMatchPairs(beforeTokens, afterTokens).forEach(([beforeIndex, afterIndex]) => {
        matchedBefore.add(beforeIndex);
        matchedAfter.add(afterIndex);
        if (beforeTokens[beforeIndex].text !== afterTokens[afterIndex].text) {
            beforeFlags[beforeIndex] = 'format';
            afterFlags[afterIndex] = 'word-after';
        }
    });

    beforeTokens.forEach((_, index) => {
        if (!matchedBefore.has(index)) beforeFlags[index] = 'word-before';
    });
    afterTokens.forEach((_, index) => {
        if (!matchedAfter.has(index)) afterFlags[index] = 'word-after';
    });

    return {
        beforeHtml: renderTranscriptWithTokenHighlights(beforeText, beforeTokens, beforeFlags),
        afterHtml: renderTranscriptWithTokenHighlights(afterText, afterTokens, afterFlags)
    };
}

function getTokenHighlightStyle(flag) {
    if (flag === 'format') return 'background:rgba(245,158,11,0.32);border-radius:2px;';
    if (flag === 'word-before') return 'background:rgba(239,68,68,0.30);border-radius:2px;';
    if (flag === 'word-after') return 'background:rgba(34,197,94,0.30);border-radius:2px;';
    return '';
}

function renderTranscriptWithTokenHighlights(text, tokens, flags) {
    let html = '';
    let cursor = 0;
    tokens.forEach((token, index) => {
        html += escapeHtml(String(text || '').slice(cursor, token.start));
        const style = getTokenHighlightStyle(flags[index]);
        const tokenHtml = escapeHtml(String(text || '').slice(token.start, token.end));
        html += style ? `<span style="${style}">${tokenHtml}</span>` : tokenHtml;
        cursor = token.end;
    });
    html += escapeHtml(String(text || '').slice(cursor));
    return html;
}

function renderWidgetButton(label, action, isActive = false) {
    const background = isActive ? '#334155' : '#1e293b';
    const border = isActive ? '#60a5fa' : '#475569';
    return `<button data-lbh-nodrag data-lbh-action="${action}" style="background:${background};color:#e5e7eb;border:1px solid ${border};border-radius:4px;padding:4px 10px;font:inherit;cursor:pointer;">${label}</button>`;
}

let lastWidgetActionName = '';
let lastWidgetActionAt = 0;

function runWidgetAction(action) {
    const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (action === lastWidgetActionName && now - lastWidgetActionAt < 250) return;
    lastWidgetActionName = action;
    lastWidgetActionAt = now;

    if (action === 'toggle-transcript') {
        toggleTranscriptPanel();
    } else if (action === 'open-reference') {
        openReferenceModal();
    } else if (action === 'close-reference') {
        closeReferenceModal();
    } else if (action === 'copy-before') {
        copyTranscriptSection('before');
    } else if (action === 'copy-after') {
        copyTranscriptSection('after');
    }
}

function getWidgetActionElement(target) {
    return closestFromEventTarget(target, '#lbh-word-count [data-lbh-action]');
}

function handleWidgetActionPress(e) {
    if (typeof e.button === 'number' && e.button !== 0) return false;

    const actionEl = getWidgetActionElement(e.target);
    if (!actionEl) return false;

    e.preventDefault();
    e.stopImmediatePropagation();
    runWidgetAction(actionEl.getAttribute('data-lbh-action'));
    return true;
}

function suppressWidgetActionClick(e) {
    if (!getWidgetActionElement(e.target)) return false;

    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
}

function getAccuracyColor(accuracyPct) {
    const pct = Math.max(0, Math.min(100, Number(accuracyPct) || 0));
    if (pct >= 95) return '#22c55e';
    if (pct >= 85) return '#84cc16';
    if (pct >= 70) return '#f59e0b';
    if (pct >= 50) return '#f97316';
    return '#ef4444';
}

function getAccuracyNoteHtml() {
    return '<div style="color:#94a3b8;font-size:12px;line-height:1.35;max-width:260px;white-space:normal;overflow-wrap:anywhere;margin:2px auto 0;">Format errors also reduce total accuracy. Missing periods, commas, and speaker role mistakes do not.</div>';
}

function ensureReferenceModal() {
    if (referenceModal && document.body.contains(referenceModal)) return referenceModal;

    referenceModal = document.createElement('div');
    referenceModal.id = 'lbh-reference-modal';
    referenceModal.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:none',
        'align-items:center',
        'justify-content:center',
        'background:rgba(2, 6, 23, 0.78)',
        'padding:24px'
    ].join(';');

    document.body.appendChild(referenceModal);
    referenceModal.addEventListener('mousedown', e => {
        e.stopPropagation();
    });
    referenceModal.addEventListener('click', e => {
        const actionEl = closestFromEventTarget(e.target, '[data-lbh-action="close-reference"]');
        if (actionEl) {
            e.preventDefault();
            e.stopPropagation();
            closeReferenceModal();
            return;
        }
        if (e.target === referenceModal) {
            closeReferenceModal();
            return;
        }
        e.stopPropagation();
    });
    return referenceModal;
}

function closeReferenceModal() {
    const modal = ensureReferenceModal();
    modal.style.display = 'none';
    modal.innerHTML = '';
}

function openReferenceModal() {
    const modal = ensureReferenceModal();
    const criteriaUrl = chrome.runtime.getURL('criteria.png');
    modal.innerHTML =
        '<div data-lbh-nodrag style="position:relative;max-width:min(92vw, 1200px);max-height:92vh;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;box-shadow:0 20px 60px rgba(0,0,0,0.45);">' +
            '<button data-lbh-nodrag data-lbh-action="close-reference" style="position:absolute;top:10px;right:10px;background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:4px;padding:4px 10px;font:inherit;cursor:pointer;">Close</button>' +
            '<img src="' + criteriaUrl + '" alt="Reference criteria" style="display:block;max-width:100%;max-height:calc(92vh - 24px);border-radius:4px;" />' +
        '</div>';
    modal.style.display = 'flex';
}


function renderWordCountWidgetLegacy(totalWords, totalSegments, totalMs) {
    if (widgetDismissed) return;
    const widget = ensureWordCountWidget();
    const dot = '<span style="color:#9ca3af;margin:0 5px;">·</span>';
    let html =
        '<span style="color:#e5e7eb;margin-right:4px;">Words</span>' +
        `<span style="color:#3b82f6;font-weight:600;">${totalWords.toLocaleString()}</span>` +
        dot +
        '<span style="color:#e5e7eb;margin-right:4px;">Segments</span>' +
        `<span style="color:#ffffff;margin-right:8px;">${totalSegments}</span>` +
        '<span data-lbh-close style="color:#e5e7eb;cursor:pointer;padding:0 2px;border-radius:3px;font-size:16px;line-height:1;" title="Hide badge (click extension icon to restore)">×</span>';

    if (totalMs > 0) {
        html +=
            '<br>' +
            '<span style="color:#e5e7eb;margin-right:4px;">TT</span>' +
            `<span style="color:#10b981;font-weight:600;">${formatDuration(totalMs)}</span>`;

        if (selectionDurationMs >= 0) {
            const pct = (selectionDurationMs / totalMs * 100).toFixed(1);
            html +=
                dot +
                '<span style="color:#e5e7eb;margin-right:4px;">Sel</span>' +
                `<span style="color:#a78bfa;font-weight:600;">${formatDuration(selectionDurationMs)}</span>` +
                dot +
                `<span style="color:#a78bfa;">${pct}%</span>`;
        } else {
            const fivePercMs = totalMs * 0.05;
            html +=
                dot +
                '<span style="color:#e5e7eb;margin-right:4px;">5%</span>' +
                `<span style="color:#f59e0b;font-weight:600;">${formatDuration(fivePercMs)}</span>`;
        }
    }

    if (transcriptionCapture.metrics) {
        const accuracyColor = getAccuracyColor(transcriptionCapture.metrics.totalAccuracyPct);
        html +=
            '<br>' +
            '<span style="color:#e5e7eb;margin-right:4px;">Acc</span>' +
            `<span style="color:${accuracyColor};font-weight:600;">${transcriptionCapture.metrics.totalAccuracyPct.toFixed(1)}%</span>` +
            dot +
            '<span style="color:#e5e7eb;margin-right:4px;">Fmt</span>' +
            `<span style="color:#60a5fa;font-weight:600;">${transcriptionCapture.metrics.formatAccuracyPct.toFixed(1)}%</span>` +
            getAccuracyNoteHtml();
    }

    html +=
        '<div data-lbh-nodrag style="margin-top:10px;padding-top:8px;border-top:1px solid #334155;">' +
            '<div style="color:#cbd5e1;font-weight:700;letter-spacing:0.02em;">Transcription</div>' +
        '</div>' +
        renderTranscriptSection('Before', transcriptionCapture.before ? (transcriptionCapture.before.displayText || transcriptionCapture.before.text) : '', '#f59e0b') +
        renderTranscriptSection('After', transcriptionCapture.after ? (transcriptionCapture.after.displayText || transcriptionCapture.after.text) : '', '#22c55e');

    if (html !== lastRenderedWidgetHtml) {
        widget.innerHTML = html;
        lastRenderedWidgetHtml = html;
        protectTranscriptTextareaEvents(widget);
    }
    widget.style.display = '';
}

function renderWordCountWidget(totalWords, totalSegments, totalMs) {
    if (widgetDismissed) return;
    const widget = ensureWordCountWidget();
    applyWidgetSizeMode(widget);
    const dot = '<span style="color:#9ca3af;margin:0 5px;">&middot;</span>';
    const summaryAlign = 'center';
    let summaryHtml = '';

    if (totalMs > 0) {
        summaryHtml +=
            '<span style="color:#e5e7eb;margin-right:4px;">TT</span>' +
            `<span style="color:#10b981;font-weight:600;">${formatDuration(totalMs)}</span>`;

        if (selectionDurationMs >= 0) {
            const pct = (selectionDurationMs / totalMs * 100).toFixed(1);
            summaryHtml +=
                dot +
                '<span style="color:#e5e7eb;margin-right:4px;">Sel</span>' +
                `<span style="color:#a78bfa;font-weight:600;">${formatDuration(selectionDurationMs)}</span>` +
                dot +
                `<span style="color:#a78bfa;">${pct}%</span>`;
        } else {
            const fivePercMs = totalMs * 0.05;
            summaryHtml +=
                dot +
                '<span style="color:#e5e7eb;margin-right:4px;">5%</span>' +
                `<span style="color:#f59e0b;font-weight:600;">${formatDuration(fivePercMs)}</span>`;
        }
    }

    if (transcriptionCapture.metrics) {
        const accuracyColor = getAccuracyColor(transcriptionCapture.metrics.totalAccuracyPct);
        summaryHtml +=
            (summaryHtml ? '<br>' : '') +
            '<span style="color:#e5e7eb;margin-right:4px;">Acc</span>' +
            `<span style="color:${accuracyColor};font-weight:600;">${transcriptionCapture.metrics.totalAccuracyPct.toFixed(1)}%</span>` +
            dot +
            '<span style="color:#e5e7eb;margin-right:4px;" title="Capitalization and other non-word formatting edits">Format</span>' +
            `<span style="color:#60a5fa;font-weight:600;">${transcriptionCapture.metrics.formatAccuracyPct.toFixed(1)}%</span>` +
            getAccuracyNoteHtml();
    }

    if (!summaryHtml) {
        summaryHtml = '<span style="color:#94a3b8;">Click to show transcription</span>';
    }

    let html =
        `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">` +
            `<div style="flex:1;text-align:${summaryAlign};">` +
                summaryHtml +
            '</div>' +
            '<button data-lbh-close data-lbh-nodrag style="color:#e5e7eb;cursor:pointer;padding:0 2px;border-radius:3px;font-size:16px;line-height:1;background:transparent;border:none;" title="Hide badge (click extension icon to restore)">&times;</button>' +
        '</div>' +
        '<div data-lbh-nodrag style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
            renderWidgetButton(transcriptPanelExpanded ? 'Hide Transcript' : 'Show Transcript', 'toggle-transcript', transcriptPanelExpanded) +
            renderWidgetButton('Rating Criteria', 'open-reference') +
        '</div>';

    if (transcriptPanelExpanded) {
        const beforeText = transcriptionCapture.before ? (transcriptionCapture.before.displayText || transcriptionCapture.before.text) : '';
        const afterText = transcriptionCapture.after ? (transcriptionCapture.after.displayText || transcriptionCapture.after.text) : '';
        const diffHtml = buildTranscriptDiffHighlights(beforeText, afterText);
        html +=
            '<div data-lbh-nodrag style="margin-top:10px;padding-top:8px;border-top:1px solid #334155;">' +
                '<div style="color:#cbd5e1;font-weight:700;letter-spacing:0.02em;text-align:center;">Transcription</div>' +
            '</div>' +
            renderTranscriptSection('Before', beforeText, '#f59e0b', diffHtml.beforeHtml) +
            renderTranscriptSection('After', afterText, '#22c55e', diffHtml.afterHtml);
    }

    if (html !== lastRenderedWidgetHtml) {
        widget.innerHTML = html;
        lastRenderedWidgetHtml = html;
        protectTranscriptTextareaEvents(widget);
    }
    widget.style.display = '';
}

function updateWordCount() {
    if (isTopFrame()) {
        updateTranscriptionCapture();
        const local = getLocalCounts();
        // Suppress TT when timeline is confirmed narrow (sidebar covering it).
        // containerWidth 0 means not yet reported — don't suppress in that case.
        const timelineWide = childFrameCount.containerWidth === 0 || childFrameCount.containerWidth >= 500;
        const ttMs = timelineWide
            ? (networkTtMs >= 0             ? networkTtMs :
               childFrameTtMs >= 0          ? childFrameTtMs :
               childFrameCount.deduplicatedTtMs > 0 ? childFrameCount.deduplicatedTtMs :
               (local.totalMs + childFrameCount.totalMs))
            : 0;
        renderWordCountWidget(
            local.words + childFrameCount.words,
            local.segments + childFrameCount.segments,
            ttMs
        );
    } else {
        const local = getLocalCounts();
        const container = getTimelineContainer();
        const containerWidth = container ? container.getBoundingClientRect().width : 0;
        if (DEBUG_LOGS && containerWidth !== updateWordCount._lastLoggedWidth) {
            updateWordCount._lastLoggedWidth = containerWidth;
            console.log('[LBH] waveform container width px:', containerWidth);
        }
        const deduplicatedTtMs = getDeduplicatedTtMs();
        try {
            window.parent.postMessage(
                { type: 'LBH_WORD_COUNT', words: local.words, segments: local.segments, totalMs: local.totalMs, containerWidth, deduplicatedTtMs },
                '*'
            );
            window.parent.postMessage(
                {
                    type: 'LBH_TRANSCRIPTION_STATE',
                    rowKey: getCurrentDataRowKey(),
                    savedSnapshot: buildSavedTranscriptSnapshot(),
                    liveSnapshot: buildLiveTranscriptSnapshot()
                },
                '*'
            );
            const ttMs = extractTtMsFromTimestamps();
            if (ttMs >= 0) {
                window.parent.postMessage({ type: 'LBH_TT_MS', ttMs }, '*');
            }
        } catch (e) { /* cross-origin guard */ }
    }
}

// Top frame: receive child frame reports and re-render
if (isTopFrame()) {
    window.addEventListener('message', e => {
        if (!e.data) return;

        if (e.data.type === 'LBH_WORD_COUNT') {
            childFrameCount = { words: e.data.words, segments: e.data.segments, totalMs: e.data.totalMs || 0, containerWidth: e.data.containerWidth || 0, deduplicatedTtMs: e.data.deduplicatedTtMs || 0 };
        } else if (e.data.type === 'LBH_TRANSCRIPTION_STATE') {
            childFrameTranscript = {
                rowKey: e.data.rowKey || '',
                savedSnapshot: e.data.savedSnapshot ? cloneTranscriptSnapshot(e.data.savedSnapshot) : null,
                liveSnapshot: e.data.liveSnapshot ? cloneTranscriptSnapshot(e.data.liveSnapshot) : null
            };
            updateTranscriptionCapture();
            if (settings.enabled) scheduleCheck();
            return;
        } else if (e.data.type === 'LBH_TT_MS') {
            childFrameTtMs = e.data.ttMs;
        } else if (e.data.type === 'LBH_SELECTION') {
            selectionDurationMs = e.data.durationMs;
            if (settings.enabled) scheduleCheck();
            return;
        } else {
            return;
        }

        if (wordCountWidget && wordCountWidget.style.display !== 'none') {
            const local = getLocalCounts();
            const timelineWide = childFrameCount.containerWidth === 0 || childFrameCount.containerWidth >= 500;
            const ttMs = timelineWide
                ? (networkTtMs >= 0             ? networkTtMs :
                   childFrameTtMs >= 0          ? childFrameTtMs :
                   childFrameCount.deduplicatedTtMs > 0 ? childFrameCount.deduplicatedTtMs :
                   (local.totalMs + childFrameCount.totalMs))
                : 0;
            renderWordCountWidget(
                local.words + childFrameCount.words,
                local.segments + childFrameCount.segments,
                ttMs
            );
        }
    });
}

function hideWordCountWidget() {
    if (!isTopFrame()) return;
    if (wordCountWidget) wordCountWidget.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────

function sanitizeStringArray(value, fallback) {
    if (!Array.isArray(value)) return [...fallback];
    return value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(item => item.length > 0);
}

function normalizeSettings(raw) {
    const wordsToHighlight = sanitizeStringArray(raw.wordsToHighlight, DEFAULT_SETTINGS.wordsToHighlight);
    const wordsToHighlightCaseSensitive = sanitizeStringArray(raw.wordsToHighlightCaseSensitive, DEFAULT_SETTINGS.wordsToHighlightCaseSensitive);

    return {
        enabled: true,
        enableCaseInsensitiveWords: raw.enableCaseInsensitiveWords !== false,
        enableCaseSensitiveWords: raw.enableCaseSensitiveWords !== false,
        enablePunctuation: raw.enablePunctuation !== false,
        enableOrangeAngle: raw.enableOrangeAngle !== false,
        wordsToHighlight: wordsToHighlight.length ? wordsToHighlight : [...DEFAULT_SETTINGS.wordsToHighlight],
        wordsToHighlightCaseSensitive: wordsToHighlightCaseSensitive.length ? wordsToHighlightCaseSensitive : [...DEFAULT_SETTINGS.wordsToHighlightCaseSensitive],
        remoteRemoved: sanitizeStringArray(raw.remoteRemoved, []),
        remoteCommunityAudit: sanitizeStringArray(raw.remoteCommunityAudit, []),
        remoteSrFlag: sanitizeStringArray(raw.remoteSrFlag, [])
    };
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildWordRegex(words, flags) {
    if (!words.length) return null;
    const escapedWords = words.map(escapeRegex);
    return new RegExp(`\\b(?:${escapedWords.join('|')})\\b`, flags);
}

function buildPhraseRegex(words, flags) {
    if (!words.length) return null;
    const escapedWords = words.map(escapeRegex);
    return new RegExp(`(?:${escapedWords.join('|')})`, flags);
}

function collectRanges(text, regex, priority, priorities) {
    if (!regex) return;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (regex === nonAnglePunctuationRegex && shouldIgnorePunctuationMatch(text, start, match[0])) {
            continue;
        }
        if (end <= start) {
            regex.lastIndex += 1;
            continue;
        }
        for (let i = start; i < end; i += 1) {
            priorities[i] = Math.max(priorities[i], priority);
        }
    }
}

function addUniqueToken(tokens, value) {
    if (!tokens.includes(value)) {
        tokens.push(value);
    }
}

function collectMatchedTokens(text, regex, tokens) {
    if (!regex) return;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (regex === nonAnglePunctuationRegex && shouldIgnorePunctuationMatch(text, match.index, match[0])) {
            continue;
        }
        if (match[0].length === 0) {
            regex.lastIndex += 1;
            continue;
        }
        addUniqueToken(tokens, match[0]);
    }
}

function isIgnoredDashMatch(text, matchIndex, matchValue) {
    if (matchValue !== '-') return false;
    if (matchIndex <= 0 || matchIndex + 4 > text.length) return false;
    return text.slice(matchIndex - 1, matchIndex + 4).toLowerCase() === 'x-ray';
}

function isPermittedBracketOnlyText(text) {
    const normalized = text.trim().toLowerCase();
    return permittedBracketOnlyTexts.includes(normalized);
}

function isIgnoredBracketMatch(text, matchValue) {
    if (matchValue !== '[' && matchValue !== ']') return false;
    return isPermittedBracketOnlyText(text);
}

function shouldIgnorePunctuationMatch(text, matchIndex, matchValue) {
    return isIgnoredDashMatch(text, matchIndex, matchValue) || isIgnoredBracketMatch(text, matchValue);
}

function hasRelevantPunctuationMatch(text) {
    nonAnglePunctuationRegex.lastIndex = 0;
    let match;
    while ((match = nonAnglePunctuationRegex.exec(text)) !== null) {
        if (shouldIgnorePunctuationMatch(text, match.index, match[0])) {
            continue;
        }
        return true;
    }
    return false;
}

function collectAngleBracketRanges(text, priorities, tokens, currentSettings) {
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (char === '<') {
            const closeIndex = text.indexOf('>', i + 1);
            if (closeIndex === -1) {
                priorities[i] = Math.max(priorities[i], 2);
                if (tokens) addUniqueToken(tokens, '<');
                continue;
            }

            if (closeIndex === i + 1) {
                priorities[i] = Math.max(priorities[i], 2);
                priorities[closeIndex] = Math.max(priorities[closeIndex], 2);
                if (tokens) addUniqueToken(tokens, '<>');
                i = closeIndex;
                continue;
            }

            if (currentSettings.enableOrangeAngle) {
                for (let j = i; j <= closeIndex; j += 1) {
                    priorities[j] = Math.max(priorities[j], 1);
                }
                if (tokens) addUniqueToken(tokens, text.slice(i, closeIndex + 1));
            }

            i = closeIndex;
            continue;
        }

        if (char === '>') {
            priorities[i] = Math.max(priorities[i], 2);
            if (tokens) addUniqueToken(tokens, '>');
        }
    }
}

function collectSquareBracketRanges(text, priorities, tokens) {
    if (isPermittedBracketOnlyText(text)) {
        return;
    }

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (char === '[') {
            const closeIndex = text.indexOf(']', i + 1);
            if (closeIndex === -1) {
                priorities[i] = Math.max(priorities[i], 2);
                if (tokens) addUniqueToken(tokens, '[');
                continue;
            }

            for (let j = i; j <= closeIndex; j += 1) {
                priorities[j] = Math.max(priorities[j], 2);
            }
            if (tokens) addUniqueToken(tokens, text.slice(i, closeIndex + 1));

            i = closeIndex;
            continue;
        }

        if (char === ']') {
            priorities[i] = Math.max(priorities[i], 2);
            if (tokens) addUniqueToken(tokens, ']');
        }
    }
}

function getTriggeredTokens(text, matchers, currentSettings) {
    const tokens = [];
    const priorities = new Uint8Array(text.length);

    collectAngleBracketRanges(text, priorities, tokens, currentSettings);
    collectSquareBracketRanges(text, priorities, tokens);

    if (currentSettings.enablePunctuation) {
        collectMatchedTokens(text, nonAnglePunctuationRegex, tokens);
    }

    collectMatchedTokens(text, matchers.caseInsensitiveRegex, tokens);
    collectMatchedTokens(text, matchers.caseSensitiveRegex, tokens);
    collectMatchedTokens(text, matchers.srFlagRegex, tokens);
    collectMatchedTokens(text, matchers.communityAuditRegex, tokens);
    collectMatchedTokens(text, matchers.removedRegex, tokens);

    return tokens;
}

function logHighlightChangeIfNeeded(targetElement, isHighlighted, triggeredTokens, contextKey) {
    const previousState = targetElement._lbhPreviousHighlightState;
    const previousSignature = targetElement._lbhPreviousHighlightSignature || "";
    const currentSignature = isHighlighted
        ? `${contextKey}|${triggeredTokens.join('')}`
        : "";
    const changed = previousState !== isHighlighted || previousSignature !== currentSignature;

    if (changed) {
        if (DEBUG_LOGS && isHighlighted) {
            console.log("Highlighter: Triggered tokens:", triggeredTokens);
        } else if (DEBUG_LOGS && previousState) {
            console.log("Highlighter: Highlight cleared");
        }
    }

    targetElement._lbhPreviousHighlightState = isHighlighted;
    targetElement._lbhPreviousHighlightSignature = currentSignature;
}

// Priority levels:
//   5 = pink  (remote removed)
//   4 = purple (remote community audit)
//   3 = blue   (remote SR flag)
//   2 = red   (words, punctuation, brackets)
//   1 = orange (<...> angle brackets)
function buildHighlightedHtml(text, matchers, currentSettings) {
    if (!text) return { hasMatch: false, html: "" };

    const priorities = new Uint8Array(text.length);
    collectAngleBracketRanges(text, priorities, null, currentSettings);
    collectSquareBracketRanges(text, priorities, null);

    if (currentSettings.enablePunctuation) {
        collectRanges(text, nonAnglePunctuationRegex, 2, priorities);
    }

    collectRanges(text, matchers.caseInsensitiveRegex, 2, priorities);
    collectRanges(text, matchers.caseSensitiveRegex, 2, priorities);
    collectRanges(text, matchers.srFlagRegex, 3, priorities);
    collectRanges(text, matchers.communityAuditRegex, 4, priorities);
    collectRanges(text, matchers.removedRegex, 5, priorities);

    let hasMatch = false;
    let html = "";
    let segmentStart = 0;
    let currentPriority = priorities[0];

    for (let i = 0; i <= text.length; i += 1) {
        const nextPriority = i < text.length ? priorities[i] : 255;
        if (i === text.length || nextPriority !== currentPriority) {
            const chunk = escapeHtml(text.slice(segmentStart, i));
            if (currentPriority === 5) {
                hasMatch = true;
                html += `<span style="background-color:${pinkTextHighlightColor};border-radius:2px;">${chunk}</span>`;
            } else if (currentPriority === 4) {
                hasMatch = true;
                html += `<span style="background-color:${purpleTextHighlightColor};border-radius:2px;">${chunk}</span>`;
            } else if (currentPriority === 3) {
                hasMatch = true;
                html += `<span style="background-color:${blueTextHighlightColor};border-radius:2px;">${chunk}</span>`;
            } else if (currentPriority === 2) {
                hasMatch = true;
                html += `<span style="background-color:${redTextHighlightColor};border-radius:2px;">${chunk}</span>`;
            } else if (currentPriority === 1) {
                hasMatch = true;
                html += `<span style="background-color:${orangeTextHighlightColor};border-radius:2px;">${chunk}</span>`;
            } else {
                html += chunk;
            }
            segmentStart = i;
            currentPriority = nextPriority;
        }
    }

    return { hasMatch, html: hasMatch ? html : "" };
}

function syncOverlayPosition(textarea, overlay) {
    overlay.style.left = `${textarea.offsetLeft}px`;
    overlay.style.top = `${textarea.offsetTop}px`;
    overlay.style.width = `${textarea.offsetWidth}px`;
    overlay.style.height = `${textarea.offsetHeight}px`;
}

function ensureTextareaOverlay(textarea) {
    let overlay = textarea._lbhOverlay;
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.pointerEvents = 'none';
        overlay.style.whiteSpace = 'pre-wrap';
        overlay.style.wordBreak = 'break-word';
        overlay.style.overflow = 'hidden';
        overlay.style.color = 'transparent';
        overlay.style.zIndex = '0';
        textarea.parentElement.appendChild(overlay);
        textarea._lbhOverlay = overlay;
    }

    const parentStyle = window.getComputedStyle(textarea.parentElement);
    if (parentStyle.position === 'static') {
        textarea.parentElement.style.position = 'relative';
    }

    const textareaStyle = window.getComputedStyle(textarea);
    overlay.style.padding = textareaStyle.padding;
    overlay.style.font = textareaStyle.font;
    overlay.style.letterSpacing = textareaStyle.letterSpacing;
    overlay.style.lineHeight = textareaStyle.lineHeight;
    overlay.style.textAlign = textareaStyle.textAlign;
    overlay.style.boxSizing = textareaStyle.boxSizing;
    overlay.style.border = textareaStyle.border;

    syncOverlayPosition(textarea, overlay);
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;

    if (!textarea._lbhOverlayListenerAttached) {
        textarea.addEventListener('scroll', () => {
            if (textarea._lbhOverlay) {
                textarea._lbhOverlay.scrollTop = textarea.scrollTop;
                textarea._lbhOverlay.scrollLeft = textarea.scrollLeft;
            }
        });
        textarea._lbhOverlayListenerAttached = 'true';
    }

    textarea.style.position = 'relative';
    textarea.style.zIndex = '1';
    textarea.style.backgroundColor = 'transparent';

    return overlay;
}

function clearTextareaOverlay(textarea) {
    if (textarea._lbhOverlay) {
        textarea._lbhOverlay.remove();
        delete textarea._lbhOverlay;
    }
    textarea.style.backgroundColor = '';
}

const COMMUNITY_HIGHLIGHT_CLASS = 'lbh-hl';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT']);

function clearPageTextHighlights() {
    document.querySelectorAll(`.${COMMUNITY_HIGHLIGHT_CLASS}`).forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
    });
}

function highlightPageText(matchers) {
    const hasCommunity = settings.remoteRemoved.length + settings.remoteCommunityAudit.length + settings.remoteSrFlag.length > 0;
    if (!hasCommunity) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const el = node.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
            if (el.closest('[contenteditable="true"]') || el.closest('#lbh-word-count')) return NodeFilter.FILTER_REJECT;
            if (el.classList.contains(COMMUNITY_HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
            if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    for (const textNode of nodes) {
        const text = textNode.textContent;
        const priorities = new Uint8Array(text.length);

        collectRanges(text, matchers.removedRegex, 5, priorities);
        collectRanges(text, matchers.communityAuditRegex, 4, priorities);
        collectRanges(text, matchers.srFlagRegex, 3, priorities);

        if (!priorities.some(p => p >= 3)) continue;

        const fragment = document.createDocumentFragment();
        let start = 0;
        let curP = priorities[0];

        for (let i = 0; i <= text.length; i++) {
            const nextP = i < text.length ? priorities[i] : 255;
            if (i === text.length || nextP !== curP) {
                const chunk = text.slice(start, i);
                if (curP >= 3) {
                    const span = document.createElement('span');
                    span.className = COMMUNITY_HIGHLIGHT_CLASS;
                    const color = curP === 5 ? pinkTextHighlightColor : curP === 4 ? purpleTextHighlightColor : blueTextHighlightColor;
                    span.style.cssText = `background-color:${color};border-radius:2px;`;
                    span.textContent = chunk;
                    fragment.appendChild(span);
                } else {
                    fragment.appendChild(document.createTextNode(chunk));
                }
                start = i;
                curP = nextP;
            }
        }

        if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
    }
}

function clearAllHighlights() {
    clearPageTextHighlights();
    const textareas = document.querySelectorAll('textarea');
    textareas.forEach(textarea => {
        clearTextareaOverlay(textarea);
        delete textarea._lbhPreviousHighlightState;
        delete textarea._lbhPreviousHighlightSignature;
    });

    const alertedElements = document.querySelectorAll('[data-alerted="true"]');
    alertedElements.forEach(element => {
        element.style.outline = '';
        element.style.backgroundColor = '';
        element.style.boxShadow = '';
        element.style.borderRadius = '';
        delete element.dataset.alerted;
        delete element._lbhPreviousHighlightState;
        delete element._lbhPreviousHighlightSignature;
    });

    hideWordCountWidget();
    lastRenderedWidgetHtml = '';
}

function getParentContainer(field, isVisItemContentDiv) {
    if (isVisItemContentDiv) {
        return field.parentElement && field.parentElement.tagName === 'DIV' ? field.parentElement : field;
    }
    return field.closest('.MuiInputBase-root') || field;
}

function createMatcherSet(currentSettings) {
    const caseInsensitiveWords = currentSettings.enableCaseInsensitiveWords ? currentSettings.wordsToHighlight : [];
    const caseSensitiveWords = currentSettings.enableCaseSensitiveWords ? currentSettings.wordsToHighlightCaseSensitive : [];
    const removedWords = currentSettings.remoteRemoved || [];
    const communityAuditWords = currentSettings.remoteCommunityAudit || [];
    const srFlagWords = currentSettings.remoteSrFlag || [];

    return {
        caseInsensitiveRegex: buildWordRegex(caseInsensitiveWords, 'gi'),
        caseSensitiveRegex: buildWordRegex(caseSensitiveWords, 'g'),
        caseInsensitiveTestRegex: buildWordRegex(caseInsensitiveWords, 'i'),
        caseSensitiveTestRegex: buildWordRegex(caseSensitiveWords, ''),
        removedRegex: buildPhraseRegex(removedWords, 'gi'),
        communityAuditRegex: buildPhraseRegex(communityAuditWords, 'gi'),
        srFlagRegex: buildPhraseRegex(srFlagWords, 'gi'),
        removedTestRegex: buildPhraseRegex(removedWords, 'i'),
        communityAuditTestRegex: buildPhraseRegex(communityAuditWords, 'i'),
        srFlagTestRegex: buildPhraseRegex(srFlagWords, 'i')
    };
}

function getAngleMatchState(text, currentSettings) {
    const priorities = new Uint8Array(text.length);
    collectAngleBracketRanges(text, priorities, null, currentSettings);
    return {
        hasOrange: priorities.includes(1),
        hasRed: priorities.includes(2)
    };
}

function hasSquareBracketMatch(text) {
    const priorities = new Uint8Array(text.length);
    collectSquareBracketRanges(text, priorities, null);
    return priorities.includes(2);
}

function processTextarea(field, text, matchers) {
    if (isTranscriptDisplayTextarea(field)) {
        clearTextareaOverlay(field);
        return;
    }

    const result = buildHighlightedHtml(text, matchers, settings);
    const triggeredTokens = result.hasMatch
        ? getTriggeredTokens(text, matchers, settings)
        : [];

    if (result.hasMatch) {
        const overlay = ensureTextareaOverlay(field);
        overlay.innerHTML = `${result.html}${text.endsWith('\n') ? '\n' : ''}`;
        field.dataset.alerted = 'true';
    } else {
        clearTextareaOverlay(field);
        if (field.dataset.alerted === 'true') {
            field.style.outline = '';
            field.style.borderRadius = '';
            delete field.dataset.alerted;
        }
    }

    logHighlightChangeIfNeeded(field, result.hasMatch, triggeredTokens, 'textarea');
}

function processVisItem(field, text, matchers) {
    const hasCaseInsensitiveMatch = matchers.caseInsensitiveTestRegex ? matchers.caseInsensitiveTestRegex.test(text) : false;
    const hasCaseSensitiveMatch = matchers.caseSensitiveTestRegex ? matchers.caseSensitiveTestRegex.test(text) : false;
    const hasRemovedMatch = matchers.removedTestRegex ? matchers.removedTestRegex.test(text) : false;
    const hasCommunityAuditMatch = matchers.communityAuditTestRegex ? matchers.communityAuditTestRegex.test(text) : false;
    const hasSrFlagMatch = matchers.srFlagTestRegex ? matchers.srFlagTestRegex.test(text) : false;

    const angleMatchState = getAngleMatchState(text, settings);
    const hasSquareBracketRedMatch = hasSquareBracketMatch(text);

    let hasPunctuationRedMatch = false;
    if (settings.enablePunctuation) {
        hasPunctuationRedMatch = hasRelevantPunctuationMatch(text);
    }

    const hasRedBorderMatch = hasCaseInsensitiveMatch || hasCaseSensitiveMatch || hasPunctuationRedMatch || angleMatchState.hasRed || hasSquareBracketRedMatch;
    const shouldHighlight = hasRemovedMatch || hasCommunityAuditMatch || hasSrFlagMatch || hasRedBorderMatch || angleMatchState.hasOrange;

    const outlineColor = hasRemovedMatch        ? pinkBorderColor :
                         hasCommunityAuditMatch  ? purpleBorderColor :
                         hasSrFlagMatch          ? blueBorderColor :
                         hasRedBorderMatch       ? redBorderColor :
                         orangeBorderColor;

    const parentContainer = getParentContainer(field, true);

    if (shouldHighlight) {
        parentContainer.style.setProperty('outline', outlineColor, 'important');
        parentContainer.style.setProperty('border-radius', '3px', 'important');
        parentContainer.dataset.alerted = 'true';

        const triggeredTokens = getTriggeredTokens(text, matchers, settings);
        logHighlightChangeIfNeeded(parentContainer, true, triggeredTokens, `div|${outlineColor}`);
        return;
    }

    if (parentContainer.dataset.alerted === 'true') {
        parentContainer.style.outline = '';
        parentContainer.style.borderRadius = '';
        delete parentContainer.dataset.alerted;
    }
    logHighlightChangeIfNeeded(parentContainer, false, [], 'div');
}

function getDirectHighlightOutline(text, matchers) {
    const hasCaseInsensitiveMatch = matchers.caseInsensitiveTestRegex ? matchers.caseInsensitiveTestRegex.test(text) : false;
    const hasCaseSensitiveMatch = matchers.caseSensitiveTestRegex ? matchers.caseSensitiveTestRegex.test(text) : false;
    const hasRemovedMatch = matchers.removedTestRegex ? matchers.removedTestRegex.test(text) : false;
    const hasCommunityAuditMatch = matchers.communityAuditTestRegex ? matchers.communityAuditTestRegex.test(text) : false;
    const hasSrFlagMatch = matchers.srFlagTestRegex ? matchers.srFlagTestRegex.test(text) : false;
    const angleMatchState = getAngleMatchState(text, settings);
    const hasSquareBracketRedMatch = hasSquareBracketMatch(text);
    const hasPunctuationRedMatch = settings.enablePunctuation && hasRelevantPunctuationMatch(text);
    const hasRedBorderMatch = hasCaseInsensitiveMatch || hasCaseSensitiveMatch || hasPunctuationRedMatch || angleMatchState.hasRed || hasSquareBracketRedMatch;

    if (hasRemovedMatch) return pinkBorderColor;
    if (hasCommunityAuditMatch) return purpleBorderColor;
    if (hasSrFlagMatch) return blueBorderColor;
    if (hasRedBorderMatch) return redBorderColor;
    if (angleMatchState.hasOrange) return orangeBorderColor;
    return '';
}

function applyDirectHighlightFallback(field, text, matchers) {
    if (isTranscriptDisplayTextarea(field) || isRoleComboboxTextarea(field)) {
        if (field.dataset.alerted === 'true') {
            field.style.outline = '';
            field.style.borderRadius = '';
            delete field.dataset.alerted;
        }
        return;
    }
    if (!text) return;

    const outlineColor = getDirectHighlightOutline(text, matchers);
    const target = field.matches('textarea') ? field : getParentContainer(field, true);

    if (outlineColor && !field.matches('textarea')) {
        target.style.setProperty('outline', outlineColor, 'important');
        target.style.setProperty('border-radius', '3px', 'important');
        target.dataset.alerted = 'true';
        return;
    }

    if (target.dataset.alerted === 'true') {
        target.style.outline = '';
        target.style.borderRadius = '';
        delete target.dataset.alerted;
    }
}

function getHighlightTargets() {
    return [
        ...[...document.querySelectorAll('textarea')]
            .filter(field => !isTranscriptDisplayTextarea(field) && !isRoleComboboxTextarea(field) && !field.closest('#lbh-word-count')),
        ...document.querySelectorAll('div.vis-item-content')
    ];
}

function runHighlightPass(fullReset = false) {
    if (!settings.enabled) return;

    if (fullReset) clearPageTextHighlights();
    const matchers = createMatcherSet(settings);
    const elementsToCheck = getHighlightTargets();

    elementsToCheck.forEach(field => {
        try {
            if (field.getAttribute('aria-hidden') === 'true') return;

            const text = field.value || field.textContent || '';
            const isTextarea = field.matches('textarea');

            if (isTextarea) {
                processTextarea(field, text, matchers);
                applyDirectHighlightFallback(field, text, matchers);
                return;
            }

            processVisItem(field, text, matchers);
            applyDirectHighlightFallback(field, text, matchers);
        } catch (error) {
            const fallbackText = field && (field.value || field.textContent || '');
            if (fallbackText) applyDirectHighlightFallback(field, fallbackText, matchers);
            if (DEBUG_LOGS) console.warn('[LBH] highlight scan skipped one field:', error);
        }
    });

    try {
        highlightPageText(matchers);
    } catch (error) {
        if (DEBUG_LOGS) console.warn('[LBH] page text highlight failed:', error);
    }
}

function checkLabelbox(fullReset = false) {
    if (!settings.enabled) return;

    runHighlightPass(fullReset);

    try {
        updateWordCount();
    } catch (error) {
        if (DEBUG_LOGS) console.warn('[LBH] widget update failed:', error);
    }
}

function runCheckCycle() {
    if (isCheckRunning) {
        shouldRunAgain = true;
        return;
    }

    isCheckRunning = true;
    try {
        checkLabelbox(needsFullReset);
        needsFullReset = false;
    } finally {
        isCheckRunning = false;
        if (shouldRunAgain) {
            shouldRunAgain = false;
            queueMicrotask(runCheckCycle);
        }
    }
}

function scheduleCheck(forceReset = false) {
    if (forceReset) needsFullReset = true;
    if (isCheckScheduled) return;
    isCheckScheduled = true;
    requestAnimationFrame(() => {
        isCheckScheduled = false;
        runCheckCycle();
    });
}

function invalidateRoleCacheIfNeeded(target) {
    if (getRoleValueControlFromNode(target)) {
        speakerRoleAssignmentsCache = { rowKey: '', at: 0, map: new Map() };
        return true;
    }
    return false;
}

function handlePageInputOrChange(e) {
    const roleChanged = invalidateRoleCacheIfNeeded(e.target);
    if (settings.enabled && (roleChanged || isTranscriptTextarea(e.target))) updateWordCount();
    scheduleCheck();
}

function nodeContainsTarget(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches(TARGET_SELECTOR)) return true;
    return node.querySelector(TARGET_SELECTOR) !== null;
}

function nodeContainsRoleValueControl(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (getRoleValueControlFromNode(node)) return true;
    return !!node.querySelector('textarea[role="combobox"],input[role="combobox"],textarea.MuiAutocomplete-input,input.MuiAutocomplete-input,select');
}

function shouldScheduleFromMutation(mutation) {
    if (isWidgetNode(mutation.target)) return false;
    if (invalidateRoleCacheIfNeeded(mutation.target)) return true;

    if (mutation.type === 'characterData') {
        const parent = mutation.target && mutation.target.parentElement;
        if (isWidgetNode(parent)) return false;
        return !!(parent && parent.closest('div.vis-item-content'));
    }

    if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
            if (isWidgetNode(node)) continue;
            if (nodeContainsRoleValueControl(node)) {
                speakerRoleAssignmentsCache = { rowKey: '', at: 0, map: new Map() };
                return true;
            }
        }

        for (const node of mutation.removedNodes) {
            if (isWidgetNode(node)) continue;
            if (nodeContainsRoleValueControl(node)) {
                speakerRoleAssignmentsCache = { rowKey: '', at: 0, map: new Map() };
                return true;
            }
        }

        if (nodeContainsTarget(mutation.target)) return true;

        for (const node of mutation.addedNodes) {
            if (isWidgetNode(node)) continue;
            if (nodeContainsTarget(node)) return true;
        }

        for (const node of mutation.removedNodes) {
            if (isWidgetNode(node)) continue;
            if (nodeContainsTarget(node)) return true;
        }

        // Also re-scan when new elements arrive and community lists are active
        const hasCommunity = settings.remoteRemoved.length + settings.remoteCommunityAudit.length + settings.remoteSrFlag.length > 0;
        if (hasCommunity) {
            for (const node of mutation.addedNodes) {
                if (isWidgetNode(node)) continue;
                if (node.nodeType === Node.ELEMENT_NODE) return true;
            }
        }
    }

    return false;
}

function startDomObserver() {
    if (domObserver || !document.body) return;

    domObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (shouldScheduleFromMutation(mutation)) {
                scheduleCheck();
                break;
            }
        }
    });

    domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function startHighlightWatchdog() {
    if (highlightWatchdog) return;
    if (settings.enabled) runHighlightPass();
    highlightWatchdog = window.setInterval(() => {
        if (settings.enabled) runHighlightPass();
    }, 1500);
}

// ── Timeline selection tracking ───────────────────────────────────────────────

// Child frames track clicks and report selection up; top frame owns the state.
let _selectionAnchorFraction = -1;

function publishSelectionDuration(durationMs) {
    if (isTopFrame()) {
        selectionDurationMs = durationMs;
        scheduleCheck();
    } else {
        try { window.parent.postMessage({ type: 'LBH_SELECTION', durationMs }, '*'); } catch (_) {}
    }
}

document.addEventListener('click', e => {
    if (isTranscriptDisplayTextarea(e.target)) return;

    const container = getTimelineContainer();
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const edgeTolerancePx = 8;
    const inTimeline = e.clientX >= rect.left - edgeTolerancePx && e.clientX <= rect.right + edgeTolerancePx;

    if (!inTimeline) {
        if (!e.shiftKey) {
            _selectionAnchorFraction = -1;
            publishSelectionDuration(-1);
        }
        return;
    }

    const rawFraction = (e.clientX - rect.left) / rect.width;
    const fraction = Math.max(0, Math.min(1, rawFraction));

    if (e.shiftKey) {
        const anchorFraction = _selectionAnchorFraction >= 0 ? _selectionAnchorFraction : 0;
        const totalMediaMs = getTotalMediaMs();
        if (totalMediaMs > 0) {
            const durationMs = Math.abs(fraction - anchorFraction) * totalMediaMs;
            publishSelectionDuration(durationMs);
        }
    } else if (!e.shiftKey) {
        _selectionAnchorFraction = fraction;
        publishSelectionDuration(-1);
    }
});

// ── Gist Syncing (Top Frame Only) ───────────────────────────────────────────

async function syncGist() {
    if (!isTopFrame()) return;

    const { _lbhGistId, _lbhRemoteLastFetch } = await chrome.storage.local.get(['_lbhGistId', '_lbhRemoteLastFetch']);
    if (!_lbhGistId) return;

    // Throttle: only sync if last fetch was > 5 min ago
    const now = Date.now();
    if (_lbhRemoteLastFetch && (now - _lbhRemoteLastFetch < 300000)) return;

    try {
        const response = await fetch(`https://api.github.com/gists/${_lbhGistId}`);
        if (!response.ok) return;
        const data = await response.json();

        const filename = Object.keys(data.files)[0];
        if (!filename) return;

        const content = JSON.parse(data.files[filename].content);

        await chrome.storage.local.set({
            _lbhGistFilename: filename,
            _lbhRemoteRemoved: Array.isArray(content.removed) ? content.removed : [],
            _lbhRemoteCommunityAudit: Array.isArray(content.communityAudit) ? content.communityAudit : [],
            _lbhRemoteSrFlag: Array.isArray(content.srFlag) ? content.srFlag : [],
            _lbhRemoteLastFetch: Date.now()
        });
    } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────

function loadSettingsAndApply() {
    chrome.storage.local.get({
        ...DEFAULT_SETTINGS,
        _lbhWidgetHidden: false,
        _lbhTtMs: -1,
        _lbhRemoteRemoved: [],
        _lbhRemoteCommunityAudit: [],
        _lbhRemoteSrFlag: []
    }, stored => {
        settings = normalizeSettings({
            ...stored,
            remoteRemoved: stored._lbhRemoteRemoved,
            remoteCommunityAudit: stored._lbhRemoteCommunityAudit,
            remoteSrFlag: stored._lbhRemoteSrFlag
        });
        widgetDismissed = !!stored._lbhWidgetHidden;
        networkTtMs = typeof stored._lbhTtMs === 'number' ? stored._lbhTtMs : -1;
        if (!settings.enabled) {
            clearAllHighlights();
            return;
        }
        runHighlightPass(true);
        scheduleCheck(true);
    });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    // Badge visibility toggled by popup opening
    if (changes._lbhWidgetHidden && changes._lbhWidgetHidden.newValue === false) {
        widgetDismissed = false;
        if (settings.enabled) scheduleCheck();
    }

    // Network-intercepted TT updated by network.js
    if (changes._lbhTtMs) {
        networkTtMs = changes._lbhTtMs.newValue;
        if (isTopFrame() && settings.enabled && wordCountWidget && wordCountWidget.style.display !== 'none') {
            const local = getLocalCounts();
            const ttMs = networkTtMs >= 0    ? networkTtMs :
                         childFrameTtMs >= 0  ? childFrameTtMs :
                         (local.totalMs + childFrameCount.totalMs);
            renderWordCountWidget(
                local.words + childFrameCount.words,
                local.segments + childFrameCount.segments,
                ttMs
            );
        }
    }

    const updated = { ...settings };
    let hasRelevantChange = false;

    // Remote list updates pushed by content script sync or popup edits
    if (changes._lbhRemoteRemoved) {
        updated.remoteRemoved = sanitizeStringArray(changes._lbhRemoteRemoved.newValue, []);
        hasRelevantChange = true;
    }
    if (changes._lbhRemoteCommunityAudit) {
        updated.remoteCommunityAudit = sanitizeStringArray(changes._lbhRemoteCommunityAudit.newValue, []);
        hasRelevantChange = true;
    }
    if (changes._lbhRemoteSrFlag) {
        updated.remoteSrFlag = sanitizeStringArray(changes._lbhRemoteSrFlag.newValue, []);
        hasRelevantChange = true;
    }

    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        if (changes[key]) {
            updated[key] = changes[key].newValue;
            hasRelevantChange = true;
        }
    });

    if (!hasRelevantChange) return;

    settings = normalizeSettings(updated);
    if (!settings.enabled) {
        clearAllHighlights();
        return;
    }

    scheduleCheck(true);
});

loadSettingsAndApply();
startDomObserver();
startHighlightWatchdog();
document.addEventListener('input', handlePageInputOrChange);
document.addEventListener('change', handlePageInputOrChange);

// Keep our widget controls responsive even when Labelbox registers broad click handlers.
document.addEventListener('pointerdown', handleWidgetActionPress, true);
document.addEventListener('mousedown', handleWidgetActionPress, true);
document.addEventListener('click', suppressWidgetActionClick, true);

// Capture-phase mousedown so the dismiss fires before any page handler can swallow the event
document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const btn = closestFromEventTarget(e.target, '[data-lbh-close]');
    if (!btn || !btn.closest('#lbh-word-count')) return;
    e.stopPropagation();
    widgetDismissed = true;
    if (wordCountWidget) wordCountWidget.style.display = 'none';
    chrome.storage.local.set({ _lbhWidgetHidden: true });
}, true);

document.addEventListener('click', e => {
    const actionEl = closestFromEventTarget(e.target, '[data-lbh-action]');
    if (actionEl) {
        e.preventDefault();
        e.stopPropagation();
        runWidgetAction(actionEl.getAttribute('data-lbh-action'));
        return;
    }

});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeReferenceModal();
    }
});

// Child frames immediately signal zero on load so the top frame resets
// before the new row's content arrives
if (!isTopFrame()) {
    try {
        window.parent.postMessage({ type: 'LBH_WORD_COUNT', words: 0, segments: 0, totalMs: 0 }, '*');
        window.parent.postMessage({ type: 'LBH_TRANSCRIPTION_STATE', rowKey: getCurrentDataRowKey(), savedSnapshot: null, liveSnapshot: null }, '*');
        const ttMs = extractTtMsFromTimestamps();
        if (ttMs >= 0) {
            window.parent.postMessage({ type: 'LBH_TT_MS', ttMs }, '*');
        }
    } catch (e) { /* cross-origin guard */ }
}

// Labelbox Skip Guard
(function initSkipGuard() {
    if (document.getElementById('lbsg-toast')) return;

    const style = document.createElement('style');
    style.textContent = `
        #lbsg-toast {
            position: fixed;
            bottom: 32px;
            left: 50%;
            transform: translateX(-50%) translateY(20px);
            background: #1a1a2e;
            color: #fff;
            border: 1.5px solid #e63946;
            border-radius: 10px;
            padding: 14px 22px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 14px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            z-index: 2147483647;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s ease;
            white-space: nowrap;
        }
        #lbsg-toast.visible {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
            pointer-events: all;
        }
        #lbsg-toast .lbsg-icon {
            align-items: center;
            border: 1px solid #e63946;
            border-radius: 999px;
            color: #e63946;
            display: inline-flex;
            font-size: 14px;
            font-weight: 700;
            height: 22px;
            justify-content: center;
            line-height: 1;
            width: 22px;
        }
        #lbsg-toast .lbsg-msg {
            flex: 1;
            line-height: 1.4;
        }
        #lbsg-toast .lbsg-msg strong {
            display: block;
            font-size: 13px;
            color: #e63946;
            margin-bottom: 2px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }
        #lbsg-toast .lbsg-confirm {
            background: #e63946;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 7px 16px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s;
        }
        #lbsg-toast .lbsg-confirm:hover {
            background: #c1121f;
        }
        #lbsg-toast .lbsg-cancel {
            background: transparent;
            color: #aaa;
            border: 1px solid #444;
            border-radius: 6px;
            padding: 7px 14px;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
        }
        #lbsg-toast .lbsg-cancel:hover {
            background: #333;
            color: #fff;
        }
        #lbsg-timer-bar {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 3px;
            background: #e63946;
            border-radius: 0 0 10px 10px;
            width: 100%;
            transform-origin: left;
            transform: scaleX(1);
        }
    `;
    document.head.appendChild(style);

    const toast = document.createElement('div');
    toast.id = 'lbsg-toast';
    toast.innerHTML = `
        <span class="lbsg-icon">!</span>
        <span class="lbsg-msg">
            <strong>Skip Guard</strong>
            Are you sure you want to skip?
        </span>
        <button class="lbsg-cancel" type="button">Cancel</button>
        <button class="lbsg-confirm" type="button">Yes, Skip</button>
        <div id="lbsg-timer-bar"></div>
    `;
    document.body.appendChild(toast);

    const timerBar = toast.querySelector('#lbsg-timer-bar');
    const confirmBtn = toast.querySelector('.lbsg-confirm');
    const cancelBtn = toast.querySelector('.lbsg-cancel');
    const DISMISS_MS = 4000;

    let pendingSkipFn = null;
    let dismissTimer = null;
    let bypassNextSkipClick = false;

    function findSkipButton() {
        const ariaButton = document.querySelector('button[aria-label="or press s"]');
        if (ariaButton) return ariaButton;

        for (const button of document.querySelectorAll('button')) {
            if (button.closest('#lbsg-toast')) continue;
            if (button.textContent.trim().includes('Skip')) return button;
        }
        return null;
    }

    function dismiss() {
        toast.classList.remove('visible');
        clearTimeout(dismissTimer);
        pendingSkipFn = null;
    }

    function showConfirm(doSkip) {
        pendingSkipFn = doSkip;
        clearTimeout(dismissTimer);

        timerBar.style.transition = 'none';
        timerBar.style.transform = 'scaleX(1)';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                timerBar.style.transition = `transform ${DISMISS_MS}ms linear`;
                timerBar.style.transform = 'scaleX(0)';
            });
        });

        toast.classList.add('visible');
        dismissTimer = setTimeout(dismiss, DISMISS_MS);
    }

    function confirmSkipByClick(skipButton) {
        showConfirm(() => {
            const button = document.body.contains(skipButton) ? skipButton : findSkipButton();
            if (!button) return;
            bypassNextSkipClick = true;
            button.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            }));
            bypassNextSkipClick = false;
        });
    }

    confirmBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const doSkip = pendingSkipFn;
        dismiss();
        if (doSkip) doSkip();
    });

    cancelBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
    });

    document.addEventListener('click', e => {
        if (closestFromEventTarget(e.target, '#lbsg-toast')) return;
        const skipButton = findSkipButton();
        if (!skipButton) return;
        if (!skipButton.contains(e.target) && e.target !== skipButton) return;
        if (bypassNextSkipClick) return;

        e.stopImmediatePropagation();
        e.preventDefault();
        confirmSkipByClick(skipButton);
    }, true);

    function isSkipKey(e) {
        const activeElement = document.activeElement;
        const tag = activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || activeElement?.isContentEditable) return false;
        if (e.metaKey || e.ctrlKey || e.altKey) return false;
        return e.key === 's' || e.key === 'S';
    }

    document.addEventListener('keydown', e => {
        if (!isSkipKey(e)) return;
        const skipButton = findSkipButton();
        if (!skipButton) return;

        e.stopImmediatePropagation();
        e.preventDefault();
        confirmSkipByClick(skipButton);
    }, true);

    ['keypress', 'keyup'].forEach(eventType => {
        document.addEventListener(eventType, e => {
            if (!isSkipKey(e)) return;
            const skipButton = findSkipButton();
            if (!skipButton) return;

            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);
    });
})();