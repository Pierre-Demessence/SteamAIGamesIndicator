// ==UserScript==
// @name         Steam AI Banner
// @version      1.1
// @description  Add an "AI Generated Content Disclosure" banner at the top of Steam game pages.
// @author       Pierre Demessence
// @source       https://github.com/Pierre-Demessence/SteamAIGamesIndicator
// @updateURL    https://raw.githubusercontent.com/Pierre-Demessence/SteamAIGamesIndicator/refs/heads/main/steamAIBanner.js
// @downloadURL  https://raw.githubusercontent.com/Pierre-Demessence/SteamAIGamesIndicator/refs/heads/main/steamAIBanner.js
// @match        https://store.steampowered.com/app/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Constants
    const BANNER_ID = 'tm-ai-banner';
    const SELECTORS = {
        contentDescriptors: '#game_area_content_descriptors',
        title: '#appHubAppName, .apphub_AppName',
        fallbackContainer: '#page_content, .responsive_page_template_content'
    };
    const DEBOUNCE_DELAY = 300;

    // Inject styles once
    function injectStyles() {
        if (document.getElementById(`${BANNER_ID}-styles`)) return;

        const style = document.createElement('style');
        style.id = `${BANNER_ID}-styles`;
        style.textContent = `
            #${BANNER_ID} {
                background: #ff6b6b;
                color: #fff;
                padding: 12px 16px;
                font-size: 15px;
                font-weight: 600;
                text-align: center;
                border-radius: 6px;
                margin-bottom: 10px;
                box-shadow: 0 2px 6px rgba(0,0,0,0.2);
                z-index: 9999;
            }
            #${BANNER_ID} .ai-banner-header {
                font-size: 18px;
                margin-bottom: 6px;
            }
            #${BANNER_ID} .ai-banner-description {
                font-weight: 400;
            }
        `;
        document.head.appendChild(style);
    }

    function addBanner(descriptionText) {
        if (document.getElementById(BANNER_ID)) return;

        const banner = document.createElement('div');
        banner.id = BANNER_ID;

        const header = document.createElement('div');
        header.className = 'ai-banner-header';
        header.textContent = '⚠️ AI Generated Content Disclosure';

        const description = document.createElement('div');
        description.className = 'ai-banner-description';
        description.textContent = descriptionText;

        banner.appendChild(header);
        banner.appendChild(description);

        const title = document.querySelector(SELECTORS.title);
        const container = title?.parentElement
            ?? document.querySelector(SELECTORS.fallbackContainer)
            ?? document.body;
        container.prepend(banner);
    }

    function removeBanner() {
        document.getElementById(BANNER_ID)?.remove();
    }

    function checkPage() {
        const block = document.querySelector(SELECTORS.contentDescriptors);
        if (!block) {
            removeBanner();
            return;
        }

        const header = block.querySelector('h2');
        if (!header || !/ai generated content disclosure/i.test(header.textContent)) {
            removeBanner();
            return;
        }

        const paragraphs = block.querySelectorAll('p');
        const descriptionEl = paragraphs[1];
        if (!descriptionEl) {
            removeBanner();
            return;
        }

        addBanner(descriptionEl.textContent.trim());
    }

    // Debounce helper
    function debounce(fn, wait) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // Patch history methods to dispatch custom events for SPA navigation
    function patchHistoryMethods() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function (...args) {
            originalPushState.apply(this, args);
            window.dispatchEvent(new Event('pushstate'));
        };

        history.replaceState = function (...args) {
            originalReplaceState.apply(this, args);
            window.dispatchEvent(new Event('replacestate'));
        };
    }

    // Cleanup function
    function cleanup() {
        observer.disconnect();
        removeBanner();
    }

    // Initialize
    injectStyles();
    patchHistoryMethods();
    checkPage();

    // Observe DOM changes (useful for Steam's dynamic navigation)
    const debouncedCheck = debounce(checkPage, DEBOUNCE_DELAY);
    const observer = new MutationObserver(debouncedCheck);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Listen for navigation events
    window.addEventListener('popstate', debouncedCheck);
    window.addEventListener('pushstate', debouncedCheck);
    window.addEventListener('replacestate', debouncedCheck);

    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);

})();