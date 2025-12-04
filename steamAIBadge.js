// ==UserScript==
// @name         Steam AI Badge via Background Fetch
// @version      1.0
// @description  Add an "Uses AI" badge on Steam store game tiles.
// @author       Pierre Demessence
// @match        https://store.steampowered.com/*
// @exclude      https://store.steampowered.com/app/*
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
    const FETCH_DELAY = 1000;
    const BADGE_CLASS = 'tm-ai-badge';

    const SELECTORS = {
        gameLink: "a[href*='/app/']",
        tileContainer: '._3r4Ny9tQdQZc50XDM5B2q2',
        decorators: '.CapsuleDecorators',
        // Tiles that use ds_flag badges (spotlight, main capsule, etc.)
        dsFlaggedTile: '.ds_flagged'
    };

    // State
    const knownAiAppIds = new Set();
    const checkedTiles = new WeakSet();
    const tilesByAppId = new Map();
    const fetchQueue = [];
    const fetchedAppIds = new Set();
    let queueRunning = false;

    // Inject styles once
    function injectStyles() {
        if (document.getElementById(`${BADGE_CLASS}-styles`)) return;

        const style = document.createElement('style');
        style.id = `${BADGE_CLASS}-styles`;
        style.textContent = `
            .${BADGE_CLASS} {
                background: #ff6b6b;
            }
            .ds_flag.${BADGE_CLASS} {
                background: linear-gradient(135deg, #ff6b6b 0%, #ff6b6b 100%);
                top: 52px;
                padding-left: 4px;
            }
        `;
        document.head.appendChild(style);
    }

    // Load known AI app IDs from remote JSON (with caching)
    async function loadKnownAppIds() {
        const cachedTime = await GM_getValue(CACHE_TIMESTAMP_KEY, 0);
        const now = Date.now();

        // Check if cache is still valid
        if (now - cachedTime < CACHE_TTL) {
            const cached = await GM_getValue(CACHE_KEY, null);
            if (cached) {
                cached.forEach(id => knownAiAppIds.add(String(id)));
                console.log(`[Steam AI Badge] Loaded ${knownAiAppIds.size} app IDs from cache`);
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
                            appIds.forEach(id => knownAiAppIds.add(String(id)));
                            await GM_setValue(CACHE_KEY, appIds);
                            await GM_setValue(CACHE_TIMESTAMP_KEY, now);
                            console.log(`[Steam AI Badge] Fetched and cached ${knownAiAppIds.size} app IDs`);
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

    function extractAppId(node) {
        const link = node.tagName === 'A' ? node : node.querySelector(SELECTORS.gameLink);
        if (!link) return null;

        const match = link.href.match(/\/app\/(\d+)/);
        return match ? match[1] : null;
    }

    function createBadge() {
        const badge = document.createElement('span');
        badge.classList.add(BADGE_CLASS);
        badge.classList.add('_2gxv9cF-4n9wq4yxruOTNl');

        // Warning triangle SVG icon (matching Steam's badge icon style)
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.classList.add('_3LecBjgbnwvS6bCFqxs6SC');
        svg.innerHTML = '<path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>';

        badge.appendChild(svg);
        badge.appendChild(document.createTextNode('Uses AI'));
        return badge;
    }

    function createSpotlightBadge() {
        const badge = document.createElement('div');
        badge.classList.add('ds_flag', 'ds_wishlist_flag', BADGE_CLASS);

        // Warning triangle SVG icon
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.classList.add('_3LecBjgbnwvS6bCFqxs6SC');
        svg.style.height = '10px';
        svg.style.marginRight = '4px';
        svg.innerHTML = '<path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>';

        badge.appendChild(svg);
        badge.appendChild(document.createTextNode('USES AI\u00a0\u00a0'));
        return badge;
    }

    function addBadgeToTile(tile) {
        if (tile.querySelector(`.${BADGE_CLASS}`)) return;

        // Check for CapsuleDecorators (modern tiles)
        const decorators = tile.querySelector(SELECTORS.decorators);
        if (decorators) {
            decorators.appendChild(createBadge());
            return;
        }

        // Check for ds_flagged tiles (spotlight, main capsule, etc.)
        const dsFlaggedTile = tile.closest(SELECTORS.dsFlaggedTile) ?? tile;
        if (dsFlaggedTile.classList.contains('ds_flagged')) {
            dsFlaggedTile.appendChild(createSpotlightBadge());
            return;
        }
    }

    function processTile(tile) {
        if (checkedTiles.has(tile)) return;
        checkedTiles.add(tile);

        const appId = extractAppId(tile);
        if (!appId) return;

        // Track this tile for this app ID
        if (!tilesByAppId.has(appId)) {
            tilesByAppId.set(appId, []);
        }
        tilesByAppId.get(appId).push(tile);

        // If we know it's an AI app from our pre-loaded list, badge immediately
        if (knownAiAppIds.has(appId)) {
            addBadgeToTile(tile);
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
            url: `https://store.steampowered.com/app/${appId}/`,
            onload: (res) => {
                const hasAI = res.status === 200 && /AI Generated Content Disclosure/i.test(res.responseText);

                if (hasAI) {
                    knownAiAppIds.add(appId);
                    tilesByAppId.get(appId)?.forEach(addBadgeToTile);
                }

                setTimeout(runFetchQueue, FETCH_DELAY);
            },
            onerror: () => {
                setTimeout(runFetchQueue, FETCH_DELAY);
            }
        });
    }

    function processAllTiles() {
        document.querySelectorAll(SELECTORS.gameLink).forEach(link => {
            // Try modern tile container first, then ds_flagged tile, then fallback to link
            const tile = link.closest(SELECTORS.tileContainer)
                ?? link.closest(SELECTORS.dsFlaggedTile)
                ?? link;
            processTile(tile);
        });

        if (fetchQueue.length > 0 && !queueRunning) {
            runFetchQueue();
        }
    }

    // Initialize
    async function init() {
        injectStyles();
        await loadKnownAppIds();

        // Initial scan
        processAllTiles();

        // Observe page for dynamic loading
        const observer = new MutationObserver(processAllTiles);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Delay initialization slightly to let page load
    setTimeout(init, 500);

})();
