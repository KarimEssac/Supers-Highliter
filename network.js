(function () {
    'use strict';

    const STORAGE_KEY = '_lbhTtMs';
    const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

    function isTextEditingElement(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        if (el.isContentEditable) return true;

        if (el.closest && el.closest('[contenteditable="true"],[contenteditable="plaintext-only"]')) {
            return true;
        }

        if (!el.matches) return false;
        if (el.matches('textarea')) return !el.readOnly && !el.disabled;
        if (!el.matches('input')) return false;

        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return TEXT_INPUT_TYPES.has(type) && !el.readOnly && !el.disabled;
    }

    function getEditableShiftSpaceTarget(e) {
        if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
        if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return null;

        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        for (const node of path) {
            if (node === document || node === window) break;
            if (isTextEditingElement(node)) return node;
        }

        const target = e.target && e.target.nodeType === Node.ELEMENT_NODE
            ? e.target
            : e.target && e.target.parentElement;
        if (isTextEditingElement(target)) return target;

        return isTextEditingElement(document.activeElement) ? document.activeElement : null;
    }

    function blockEditableShiftSpaceShortcut(e) {
        if (!getEditableShiftSpaceTarget(e)) return;

        // Keep native space insertion, but stop Labelbox's media shortcut from seeing it.
        e.stopImmediatePropagation();
    }

    ['keydown', 'keypress', 'keyup'].forEach(type => {
        window.addEventListener(type, blockEditableShiftSpaceShortcut, true);
        document.addEventListener(type, blockEditableShiftSpaceShortcut, true);
    });

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

    // Recursively collect [start, end] pairs from a parsed JSON value.
    function collectSegmentRanges(value, depth, out) {
        if (depth > 12 || value === null || typeof value !== 'object') return;

        const startKeys = ['start', 'startMs', 'startTime', 'begin', 'from'];
        const endKeys   = ['end',   'endMs',   'endTime',   'finish', 'to'];

        let startVal = null;
        let endVal   = null;

        for (const k of startKeys) {
            if (typeof value[k] === 'number') { startVal = value[k]; break; }
        }
        for (const k of endKeys) {
            if (typeof value[k] === 'number') { endVal = value[k]; break; }
        }

        if (startVal !== null && endVal !== null && endVal > startVal) {
            const dur = endVal - startVal;
            if (dur >= 50 && dur <= 1800000) {
                out.push([startVal, endVal]);
                return; // don't recurse further into this node
            }
        }

        const children = Array.isArray(value) ? value : Object.values(value);
        for (const child of children) {
            if (child && typeof child === 'object') {
                collectSegmentRanges(child, depth + 1, out);
            }
        }
    }

    function processPayload(data) {
        if (!data || typeof data !== 'object') return;
        const ranges = [];
        collectSegmentRanges(data, 0, ranges);
        if (ranges.length === 0) return;
        const merged = mergeRanges(ranges);
        const ttMs = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
        if (ttMs > 0) {
            chrome.storage.local.set({ [STORAGE_KEY]: ttMs });
        }
    }

    // ── Patch fetch ───────────────────────────────────────────────────────────

    const _fetch = window.fetch;
    window.fetch = function (...args) {
        const request = args[0];
        const url = typeof request === 'string' ? request : (request && request.url) || '';
        const p = _fetch.apply(this, args);
        if (url.includes('labelbox.com')) {
            p.then(response => {
                response.clone().json().then(processPayload).catch(() => {});
            }).catch(() => {});
        }
        return p;
    };

    // ── Patch WebSocket ───────────────────────────────────────────────────────

    const _WS = window.WebSocket;
    window.WebSocket = function (url, ...rest) {
        const ws = new _WS(url, ...rest);
        ws.addEventListener('message', e => {
            if (typeof e.data !== 'string') return;
            try { processPayload(JSON.parse(e.data)); } catch (_) {}
        });
        return ws;
    };
    window.WebSocket.prototype = _WS.prototype;

})();
