// ==UserScript==
// @name         Steam AI Badge
// @version      2.0
// @description  Add an "Uses AI" badge on Steam store game tiles, and a "Hide items with AI disclosure" filter on search.
// @author       Pierre Demessence
// @source       https://github.com/Pierre-Demessence/SteamAIGamesIndicator
// @updateURL    https://raw.githubusercontent.com/Pierre-Demessence/SteamAIGamesIndicator/refs/heads/main/steamAIBadge.user.js
// @downloadURL  https://raw.githubusercontent.com/Pierre-Demessence/SteamAIGamesIndicator/refs/heads/main/steamAIBadge.user.js
// @match        https://store.steampowered.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      store.steampowered.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
    'use strict';

    // Constants
    const APPIDS_URL = 'https://raw.githubusercontent.com/Pierre-Demessence/SteamAIGamesIndicator/main/appids.json';
    const CACHE_KEY = 'aiAppIds';
    const CACHE_TIMESTAMP_KEY = 'aiAppIdsCacheTime';
    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
    // Per-app fetch-result cache, so the same store pages aren't re-fetched across navigations.
    // Positives almost never change; negatives can (a game may add disclosure later), so they expire sooner.
    const FETCH_CACHE_KEY = 'aiFetchCache';
    const FETCH_CACHE_TTL_POSITIVE = 30 * 24 * 60 * 60 * 1000; // 30 days
    const FETCH_CACHE_TTL_NEGATIVE = 7 * 24 * 60 * 60 * 1000; // 7 days
    const FETCH_CACHE_SAVE_DEBOUNCE = 1500;
    const FETCH_DELAY = 1000;
    const BADGE_CLASS = 'tm-ai-badge';

    const SELECTORS = {
        gameLink: "a[href*='/app/']",
        decorators: '.CapsuleDecorators',
        dsFlagged: '.ds_flagged',
        tabItem: '.tab_item',
        searchResultRow: '.search_result_row',
        wishlistInput: 'input[data-appid]',
        wishlistItem: '[data-rfd-draggable-id^="WishlistItem-"]'
    };

    // State
    const knownAiAppIds = new Set();
    const checkedTiles = new WeakSet();
    const badgedRoots = new WeakSet();
    const tilesByAppId = new Map();
    const fetchQueue = [];
    const fetchedAppIds = new Set();
    let queueRunning = false;
    const fetchCache = new Map(); // appId -> { ai: boolean, ts: number }
    let saveTimer = null;
    let maxKnownAppId = 0; // highest app ID in the known-AI list; the list is complete up to here
    let hideAiSearch = false; // search filter: hide rows disclosed as AI (persisted)
    let searchResultsObserved = false; // guard: attach the results class observer only once

    // Inject styles once
    function injectStyles() {
        if (document.getElementById(`${BADGE_CLASS}-styles`)) return;

        const style = document.createElement('style');
        style.id = `${BADGE_CLASS}-styles`;

        // Shared geometry for our "USES AI" pill; each surface adds only its own
        // positioning on top. font-weight is pinned to 400 so we never inherit a bold
        // weight from whatever Steam container the badge lands in.
        const pillBase = `
                box-sizing: border-box;
                display: flex;
                align-items: center;
                color: #111;
                font-size: 11px;
                font-weight: 400;
                line-height: 1;
                padding: 3px 14px 3px 10px;
                white-space: nowrap;
                text-transform: uppercase;
                box-shadow: 0 0 10px #000000e6;
        `;

        style.textContent = `
            .${BADGE_CLASS} {
                background: #ff6b6b;
            }
            /* Flagged rows and spotlights reuse Steam's collapsible ds_flag pill (icon-only
               until the row is hovered), so we render our warning icon as a background image
               like the native flag instead of an inline SVG (an inline SVG gets clipped when
               collapsed). Sit in the native flag's top:12px slot, or stack 18px+5px below a
               native "On Wishlist"/"In Library" flag when one is present. */
            .ds_flag.${BADGE_CLASS} {
                top: 12px;
                background: url("data:image/svg+xml,%3Csvg width='11' height='11' viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23111111' d='M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'/%3E%3C/svg%3E") no-repeat 3px 4px #ff6b6b;
            }
            .ds_flag:not(.${BADGE_CLASS}) ~ .ds_flag.${BADGE_CLASS} {
                top: 35px;
            }
            /* Tab item and wishlist badge: absolute corner overlay. */
            .tab_item {
                position: relative;
            }
            .tab_item > .${BADGE_CLASS},
            .${BADGE_CLASS}.wishlist-badge {
                ${pillBase}
                position: absolute;
                top: 3px;
                left: 0;
                z-index: 10;
                pointer-events: none;
            }
            /* Modern capsule decorators, used on both the regular store and the personal
               calendar. Steam's own hashed decorator classes aren't present on every
               bundle (e.g. the calendar's separate React app), so we style our badge
               self-contained, mirroring the native decorator flag's geometry. */
            .CapsuleDecorators > .${BADGE_CLASS} {
                ${pillBase}
                height: 18px;
                z-index: 5;
            }
            /* Search filter: hide AI-disclosed rows, mirroring Steam's own hide filters
               (e.g. .search_results.hide_owned .ds_owned). Same (0,3,0) specificity; this
               sheet is injected after Steam's so it wins ties. */
            .search_results.hide_ai .tm-ai-row {
                height: 0;
                margin: 0;
                border: none;
                display: none;
            }
        `;

        document.head.appendChild(style);
    }

    // Register known-AI app IDs and advance the "list is complete up to here" frontier.
    function registerKnownAppIds(ids) {
        for (const id of ids) {
            const idStr = String(id);
            knownAiAppIds.add(idStr);
            const n = Number(idStr);
            if (n > maxKnownAppId) maxKnownAppId = n;
        }
    }

    // Load known AI app IDs from remote JSON (with caching)
    async function loadKnownAppIds() {
        const cachedTime = await GM_getValue(CACHE_TIMESTAMP_KEY, 0);
        const now = Date.now();

        // Check if cache is still valid
        if (now - cachedTime < CACHE_TTL) {
            const cached = await GM_getValue(CACHE_KEY, null);
            if (cached) {
                registerKnownAppIds(cached);
                console.log(`[Steam AI Badge] Loaded ${knownAiAppIds.size} app IDs from cache (max ${maxKnownAppId})`);
                return;
            }
        }

        // Fetch fresh data
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: APPIDS_URL,
                onload: async (res) => {
                    if (res.status === 200) {
                        try {
                            const appIds = JSON.parse(res.responseText);
                            registerKnownAppIds(appIds);
                            await GM_setValue(CACHE_KEY, appIds);
                            await GM_setValue(CACHE_TIMESTAMP_KEY, now);
                            console.log(`[Steam AI Badge] Fetched and cached ${knownAiAppIds.size} app IDs (max ${maxKnownAppId})`);
                        } catch (e) {
                            console.error('[Steam AI Badge] Failed to parse app IDs:', e);
                        }
                    }
                    resolve();
                },
                onerror: () => {
                    console.error('[Steam AI Badge] Failed to fetch app IDs');
                    resolve();
                }
            });
        });
    }

    function isFreshCacheEntry(entry) {
        const ttl = entry.ai ? FETCH_CACHE_TTL_POSITIVE : FETCH_CACHE_TTL_NEGATIVE;
        return Date.now() - entry.ts < ttl;
    }

    function getFreshCacheEntry(appId) {
        const entry = fetchCache.get(appId);
        if (!entry) return null;
        if (!isFreshCacheEntry(entry)) {
            fetchCache.delete(appId);
            return null;
        }
        return entry;
    }

    // Load persisted fetch results, dropping expired entries; fresh positives become "known".
    async function loadFetchCache() {
        const stored = await GM_getValue(FETCH_CACHE_KEY, null);
        if (!stored || typeof stored !== 'object') return;

        let expired = 0;
        for (const [appId, entry] of Object.entries(stored)) {
            if (entry && typeof entry.ts === 'number' && typeof entry.ai === 'boolean' && isFreshCacheEntry(entry)) {
                fetchCache.set(appId, entry);
                if (entry.ai) knownAiAppIds.add(appId);
            } else {
                expired++;
            }
        }

        if (expired > 0) scheduleCacheSave(); // persist the pruned map
        console.log(`[Steam AI Badge] Loaded ${fetchCache.size} cached fetch results (${expired} expired)`);
    }

    function saveFetchCache() {
        clearTimeout(saveTimer);
        saveTimer = null;
        GM_setValue(FETCH_CACHE_KEY, Object.fromEntries(fetchCache));
    }

    function scheduleCacheSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveFetchCache, FETCH_CACHE_SAVE_DEBOUNCE);
    }

    function recordFetchResult(appId, ai) {
        fetchCache.set(appId, { ai, ts: Date.now() });
        // Positives are rare and valuable, so persist immediately (GM_setValue isn't awaited on
        // unload); negatives are frequent, so batch them with a debounced save.
        if (ai) {
            saveFetchCache();
        } else {
            scheduleCacheSave();
        }
    }

    function extractAppId(node) {
        // Check for wishlist item with data-appid on input
        const appIdInput = node.querySelector('input[data-appid]');
        if (appIdInput) {
            return appIdInput.dataset.appid;
        }

        // Check for data-ds-appid attribute (used on various elements)
        if (node.dataset?.dsAppid) {
            return node.dataset.dsAppid;
        }

        const link = node.tagName === 'A' ? node : node.querySelector(SELECTORS.gameLink);
        if (!link) return null;

        // Check for data-ds-appid on link
        if (link.dataset?.dsAppid) {
            return link.dataset.dsAppid;
        }

        const match = link.href.match(/\/app\/(\d+)/);
        return match ? match[1] : null;
    }

    function createWarningIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.style.height = '10px';
        svg.style.marginRight = '4px';
        svg.innerHTML = '<path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>';
        return svg;
    }

    function createBadge() {
        const badge = document.createElement('span');
        badge.classList.add(BADGE_CLASS);
        badge.appendChild(createWarningIcon());
        badge.appendChild(document.createTextNode('Uses AI'));
        return badge;
    }

    function createSpotlightBadge() {
        const badge = document.createElement('div');
        badge.classList.add('ds_flag', 'ds_wishlist_flag', BADGE_CLASS);
        // Icon comes from the .ds_flag.tm-ai-badge background image so it stays visible when
        // Steam collapses the flag to icon-only width; an inline SVG would be clipped.
        badge.appendChild(document.createTextNode('USES AI\u00a0\u00a0'));
        return badge;
    }

    function createTabItemBadge() {
        const badge = document.createElement('span');
        badge.classList.add(BADGE_CLASS);
        badge.appendChild(createWarningIcon());
        badge.appendChild(document.createTextNode('USES AI'));
        return badge;
    }

    function createWishlistBadge() {
        const badge = document.createElement('span');
        badge.classList.add(BADGE_CLASS, 'wishlist-badge');
        badge.appendChild(createWarningIcon());
        badge.appendChild(document.createTextNode('USES AI'));
        return badge;
    }

    function placeWishlistBadge(input) {
        // The badge goes on the image container; class names are dynamic, so try a few anchors.
        const panel = input.closest('[class*="Panel"]')
            ?? input.closest('[data-index]')
            ?? input.parentElement?.parentElement;
        const imgContainer = panel?.querySelector('img')?.parentElement;
        if (imgContainer) {
            imgContainer.style.position = 'relative';
            imgContainer.appendChild(createWishlistBadge());
        }
    }

    function placeWishlistItemBadge(root) {
        // Class names are hashed on the React wishlist, so anchor on the capsule <img> itself.
        const imgContainer = root.querySelector('img')?.parentElement;
        if (imgContainer) {
            imgContainer.style.position = 'relative';
            imgContainer.appendChild(createWishlistBadge());
        }
    }

    function placeCollapseFlagBadge(root) {
        // Steam's collapsible flag (icon-only until the row is hovered) needs both ds_flagged
        // and ds_collapse_flag on the container; plain rows may lack ds_flagged, so ensure both
        // so our flag badge collapses like a native one.
        root.classList.add('ds_flagged', 'ds_collapse_flag');
        root.appendChild(createSpotlightBadge());
    }

    // One descriptor per Steam tile surface: how to find its tiles, read the app ID, and badge it.
    // Order is priority: when surfaces overlap on one capsule (e.g. a ds_flagged spotlight wrapping a
    // modern capsule), the earlier entry wins. Supporting a new surface is a single new entry here.
    const TILE_TYPES = [
        {
            name: 'modern',
            scan: () => document.querySelectorAll(SELECTORS.decorators),
            getAppId: (root) => extractAppId(root.closest(SELECTORS.gameLink) ?? root.closest('[data-ds-appid]') ?? root),
            placeBadge: (root) => root.appendChild(createBadge()),
        },
        {
            name: 'spotlight',
            scan: () => document.querySelectorAll(SELECTORS.dsFlagged),
            getAppId: (root) => extractAppId(root),
            placeBadge: (root) => placeCollapseFlagBadge(root),
        },
        {
            name: 'tab',
            scan: () => document.querySelectorAll(SELECTORS.tabItem),
            getAppId: (root) => extractAppId(root),
            placeBadge: (root) => root.appendChild(createTabItemBadge()),
        },
        {
            name: 'search',
            scan: () => document.querySelectorAll(SELECTORS.searchResultRow),
            getAppId: (root) => extractAppId(root),
            placeBadge: (root) => placeCollapseFlagBadge(root),
        },
        {
            name: 'wishlist',
            scan: () => document.querySelectorAll(SELECTORS.wishlistInput),
            getAppId: (root) => root.dataset.appid,
            placeBadge: (root) => placeWishlistBadge(root),
        },
        {
            name: 'wishlistItem',
            scan: () => document.querySelectorAll(SELECTORS.wishlistItem),
            getAppId: (root) => root.dataset.rfdDraggableId?.match(/WishlistItem-(\d+)/)?.[1] ?? null,
            placeBadge: (root) => placeWishlistItemBadge(root),
        },
    ];

    // Badge a tile at most once. Overlapping surfaces expose separate, DOM-nested anchor elements for
    // the same game (a ds_flagged wrapper + the modern capsule's decorators); if an overlapping root
    // for this app is already badged, skip so the higher-priority surface wins and we never double-badge.
    // Only DOM-overlapping roots are collapsed: two DOM-disjoint surfaces for one game stay distinct
    // (so the same game in a carousel and a search row each get badged).
    function badge(type, appId, root) {
        if (badgedRoots.has(root)) return;
        const siblings = tilesByAppId.get(appId);
        if (siblings) {
            for (const { root: other } of siblings) {
                if (other !== root && badgedRoots.has(other) && (other.contains(root) || root.contains(other))) {
                    return;
                }
            }
        }
        badgedRoots.add(root);
        type.placeBadge(root);
        // Mark the search row so the "Hide items with AI disclosure" filter can hide it.
        root.closest('.search_result_row')?.classList.add('tm-ai-row');
    }

    function processRoot(type, root) {
        if (checkedTiles.has(root)) return;
        checkedTiles.add(root);

        const appId = type.getAppId(root);
        if (!appId) return;

        // Track this tile so a later fetch result can back-fill the right badge
        if (!tilesByAppId.has(appId)) {
            tilesByAppId.set(appId, []);
        }
        tilesByAppId.get(appId).push({ type, root });

        // If we know it's an AI app from our pre-loaded list, badge immediately
        if (knownAiAppIds.has(appId)) {
            badge(type, appId, root);
            return;
        }

        // Reuse a still-fresh fetch result instead of re-fetching the store page
        const cached = getFreshCacheEntry(appId);
        if (cached) {
            if (cached.ai) badge(type, appId, root);
            return;
        }

        // The known-AI list is complete up to its highest app ID, so an app at or below that
        // which isn't in the list is known to NOT use AI — only newer (higher) app IDs are unknown.
        if (maxKnownAppId > 0 && Number(appId) <= maxKnownAppId) {
            return;
        }

        // Queue for fetching if not already fetched/queued
        if (!fetchedAppIds.has(appId)) {
            fetchedAppIds.add(appId);
            fetchQueue.push(appId);
        }
    }

    function runFetchQueue() {
        if (fetchQueue.length === 0) {
            queueRunning = false;
            return;
        }
        queueRunning = true;
        const appId = fetchQueue.shift();

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://store.steampowered.com/app/${appId}/?l=english`,
            onload: (res) => {
                const hasAI = res.status === 200 && /AI Generated Content Disclosure/i.test(res.responseText);
                // Only cache a NEGATIVE when a real store page actually loaded: id="appHubAppName"
                // is present on app pages but not on age gates, login/region walls, or error pages,
                // so a transient non-page can't stick as a false negative for the whole TTL.
                const isRealStorePage = res.status === 200 && /id="appHubAppName"/.test(res.responseText);

                if (hasAI || isRealStorePage) {
                    recordFetchResult(appId, hasAI);
                }

                if (hasAI) {
                    knownAiAppIds.add(appId);
                    tilesByAppId.get(appId)?.forEach(({ type, root }) => badge(type, appId, root));
                }

                setTimeout(runFetchQueue, FETCH_DELAY);
            },
            onerror: () => {
                setTimeout(runFetchQueue, FETCH_DELAY);
            }
        });
    }

    function processAllTiles() {
        for (const type of TILE_TYPES) {
            for (const root of type.scan()) {
                processRoot(type, root);
            }
        }

        injectAiFilterControl();

        if (fetchQueue.length > 0 && !queueRunning) {
            runFetchQueue();
        }
    }

    // Reflect the current hide-AI state onto the search results container and our control.
    function applyHideAiState() {
        document.querySelector('#search_results')?.classList.toggle('hide_ai', hideAiSearch);
        const row = document.getElementById('tm-hide-ai-row');
        if (row) {
            row.classList.toggle('checked', hideAiSearch);
            row.querySelector('.tab_filter_control')?.classList.toggle('checked', hideAiSearch);
        }
    }

    // Build a native-looking filter control that toggles the hide-AI state.
    function createAiFilterControl() {
        const row = document.createElement('div');
        row.className = 'tab_filter_control_row';
        row.id = 'tm-hide-ai-row';

        const control = document.createElement('span');
        control.setAttribute('role', 'button');
        control.className = 'tab_filter_control tab_filter_control_include';

        const labelContainer = document.createElement('span');
        labelContainer.className = 'tab_filter_label_container';

        const checkbox = document.createElement('span');
        checkbox.className = 'tab_filter_control_checkbox';

        const label = document.createElement('span');
        label.className = 'tab_filter_control_label';
        label.textContent = 'Hide items with AI disclosure';

        labelContainer.appendChild(checkbox);
        labelContainer.appendChild(label);
        control.appendChild(labelContainer);
        row.appendChild(control);

        // Handle the toggle ourselves; stop propagation so Steam's filter JS doesn't also react.
        const toggle = (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideAiSearch = !hideAiSearch;
            GM_setValue('hideAiSearch', hideAiSearch);
            applyHideAiState();
        };
        control.tabIndex = 0;
        control.addEventListener('click', toggle);
        control.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) toggle(e);
        });

        return row;
    }

    // Inject the control into the search "Narrow by preferences" block (search page only).
    // Steam re-renders this block on AJAX updates, so re-inject and re-apply state each pass.
    function injectAiFilterControl() {
        const block = document.querySelector('#client_filter .block_content');
        if (block && !document.getElementById('tm-hide-ai-row')) {
            block.appendChild(createAiFilterControl());
        }

        // Steam may rewrite #search_results' class without a childList change (e.g. toggling its
        // own filters), which could drop our hide_ai class; re-apply it on any class change.
        const results = document.querySelector('#search_results');
        if (results && !searchResultsObserved) {
            searchResultsObserved = true;
            new MutationObserver(applyHideAiState)
                .observe(results, { attributes: true, attributeFilter: ['class'] });
        }

        applyHideAiState();
    }

    // Debounce helper
    function debounce(fn, wait) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // Initialize
    async function init() {
        injectStyles();
        await loadKnownAppIds();
        await loadFetchCache();
        hideAiSearch = await GM_getValue('hideAiSearch', false);

        // Flush any pending (debounced) cache write before the page goes away
        window.addEventListener('pagehide', () => {
            if (saveTimer) saveFetchCache();
        });

        // Initial scan
        processAllTiles();

        // Observe page for dynamic loading (debounced to avoid excessive calls)
        const debouncedProcess = debounce(processAllTiles, 200);
        const observer = new MutationObserver(debouncedProcess);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Delay initialization slightly to let page load
    setTimeout(init, 500);

})();
