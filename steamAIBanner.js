// ==UserScript==
// @name         Steam AI Banner
// @version      1.0
// @description  Add an "AI Generated Content Disclosure" banner at the top of Steam game pages.
// @author       Pierre Demessence
// @match        https://store.steampowered.com/app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const LABEL_ID = 'tm-ai-label';

    function addLabel(disclosureHtml) {
        if (document.getElementById(LABEL_ID)) return;

        const bar = document.createElement('div');
        bar.id = LABEL_ID;
        bar.style.background = '#ff6b6b';
        bar.style.color = '#fff';
        bar.style.padding = '12px 16px';
        bar.style.fontSize = '15px';
        bar.style.fontWeight = '600';
        bar.style.textAlign = 'center';
        bar.style.borderRadius = '6px';
        bar.style.marginBottom = '10px';
        bar.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
        bar.style.zIndex = '9999';

        bar.innerHTML = `
        <div style="font-size:18px; margin-bottom:6px;">⚠️ AI Generated Content Disclosure</div>
        <div style="font-weight:400;">${disclosureHtml}</div>
    `;

        const title = document.querySelector('#appHubAppName, .apphub_AppName');
        if (title && title.parentElement) {
            title.parentElement.prepend(bar);
        } else {
            (document.querySelector('#page_content, .responsive_page_template_content') || document.body).prepend(bar);
        }
    }

    function removeLabel() {
        const el = document.getElementById(LABEL_ID);
        if (el) el.remove();
    }

    // Check page for the disclosure text
    function checkPage() {
        try {
            const block = document.querySelector('#game_area_content_descriptors');
            if (!block) {
                removeLabel();
                return;
            }

            const header = block.querySelector('h2');
            if (!header || !/ai generated content disclosure/i.test(header.innerText)) {
                removeLabel();
                return;
            }

            const paragraphs = Array.from(block.querySelectorAll('p'));
            const description = paragraphs.map(p => p.innerHTML.trim())[1];

            addLabel(description);

        } catch (e) {
            console.error('tm-ai-label check failed', e);
        }
    }

    // Debounce helper
    function debounce(fn, wait) {
        let t;
        return function (...a) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, a), wait);
        };
    }

    // Run once on load
    checkPage();

    // Observe DOM changes (useful for Steam's dynamic navigation)
    const observer = new MutationObserver(debounce(() => checkPage(), 300));
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

    // Also re-check on history navigation (Steam often uses pushState)
    window.addEventListener('popstate', debounce(checkPage, 200));
    // Some sites fire custom events on navigation; listen to these generically
    window.addEventListener('pushstate', debounce(checkPage, 200));
    window.addEventListener('replacestate', debounce(checkPage, 200));

})();