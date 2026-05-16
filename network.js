(function () {
    'use strict';

    const STORAGE_KEY = '_lbhTtMs';

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
