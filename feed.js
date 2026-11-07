(() => {
  'use strict';

  const ITEM_ATTR = 'data-innercircle-feed-item';
  const TRUST_ATTR = 'data-innercircle-trust';
  const STYLE_ID = 'innercircle-feed-styles';
  const TEST_MODE_KEY = 'innerCircleTestMode';

  let feedParent = null;
  let postClass = null;
  let scanQueued = false;
  let trustedUrls = new Set();
  let trustedIds = new Set();
  let trustedGroupNames = new Set();
  let databaseReady = false;
  let databaseHasEntries = false;
  let settingsReady = false;
  let testMode = false;

  // Serialize counter updates so rapid hides don't lose increments.
  let hiddenCountQueue = Promise.resolve();

  function hidePost(post) {
    if (
      !post.isConnected ||
      post.dataset.innercircleCountedHidden === 'true'
    ) {
      return;
    }

    const height = Math.max(0, post.getBoundingClientRect().height);

    post.dataset.innercircleCountedHidden = 'true';
    post.remove();

    hiddenCountQueue = hiddenCountQueue.then(() => new Promise(resolve => {
      chrome.storage.local.get(
        {
          innerCircleHiddenPostCount: 0,
          innerCircleHiddenPostPixels: 0
        },
        result => {
          if (chrome.runtime.lastError) {
            console.error(
              '[InnerCircle] Could not read hidden-post totals:',
              chrome.runtime.lastError.message
            );
            resolve();
            return;
          }

          const count =
            Number(result.innerCircleHiddenPostCount) || 0;
          const pixels =
            Number(result.innerCircleHiddenPostPixels) || 0;

          chrome.storage.local.set(
            {
              innerCircleHiddenPostCount: count + 1,
              innerCircleHiddenPostPixels: pixels + height
            },
            () => {
              if (chrome.runtime.lastError) {
                console.error(
                  '[InnerCircle] Could not save hidden-post totals:',
                  chrome.runtime.lastError.message
                );
              }

              resolve();
            }
          );
        }
      );
    })).catch(error => {
      console.error('[InnerCircle] Hidden-post counter failed:', error);
    });
  }

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);

    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        html.innercircle-test-mode
          [${ITEM_ATTR}][${TRUST_ATTR}="trusted"] {
          outline: 5px solid #2e9d50 !important;
          outline-offset: -5px !important;
        }

        html.innercircle-test-mode
          [${ITEM_ATTR}][${TRUST_ATTR}="untrusted"] {
          outline: 5px solid #e53935 !important;
          outline-offset: -5px !important;
        }

        .innercircle-hide-button {
          display: none !important;
          position: absolute !important;
          top: 8px !important;
          right: 8px !important;
          z-index: 2147483647 !important;
          padding: 6px 12px !important;
          border: 0 !important;
          border-radius: 5px !important;
          background: #c62828 !important;
          color: white !important;
          font: bold 13px sans-serif !important;
          cursor: pointer !important;
        }

        html.innercircle-test-mode
          [${ITEM_ATTR}][${TRUST_ATTR}="untrusted"]
          .innercircle-hide-button {
          display: block !important;
        }
      `;

      document.documentElement.appendChild(style);
    }

    document.documentElement.classList.toggle(
      'innercircle-test-mode',
      testMode
    );
  }

  function normalizeUrl(value) {
    try {
      const url = new URL(value, location.origin);

      if (!/^https?:$/.test(url.protocol)) return null;

      url.hash = '';
      url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

      if (url.pathname === '/profile.php') {
        const id = url.searchParams.get('id');
        return id ? `${url.hostname}/profile.php?id=${id}` : null;
      }

      url.search = '';
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';

      return `${url.hostname}${url.pathname}`.toLowerCase();
    } catch {
      return null;
    }
  }

  function extractIds(value) {
    const ids = new Set();

    try {
      const url = new URL(value, location.origin);
      const path = url.pathname;

      const patterns = [
        /\/groups\/(\d+)/i,
        /\/people\/[^/]+\/(\d+)/i,
        /\/pages\/[^/]+\/(\d+)/i
      ];

      for (const pattern of patterns) {
        const match = path.match(pattern);
        if (match && match[1]) ids.add(match[1]);
      }

      const queryId = url.searchParams.get('id');
      if (queryId) ids.add(queryId);

      const segments = path.split('/').filter(Boolean);
      const last = segments.at(-1);

      if (last && /^\d+$/.test(last)) {
        ids.add(last);
      }
    } catch {
      // Ignore malformed URLs.
    }

    return ids;
  }

  function loadDatabase() {
    if (!globalThis.chrome?.storage?.local) {
      console.warn('[InnerCircle] Chrome storage is unavailable.');
      return;
    }

    chrome.storage.local.get('innerCircleDB', result => {
      if (chrome.runtime.lastError) {
        console.error(
          '[InnerCircle] Could not load database:',
          chrome.runtime.lastError.message
        );
        return;
      }

      trustedUrls = new Set();
      trustedIds = new Set();
      trustedGroupNames = new Set();

      const db = result.innerCircleDB || {};

      databaseHasEntries = [
        'friends',
        'groups',
        'following'
      ].some(category =>
        Array.isArray(db[category]) && db[category].length > 0
      );

      for (const group of Array.isArray(db.groups) ? db.groups : []) {
        if (group && typeof group.name === 'string' && group.name.trim()) {
          trustedGroupNames.add(
            group.name.trim().replace(/\s+/g, ' ').toLowerCase()
          );
        }
      }

      for (const category of ['friends', 'groups', 'following']) {
        const entries = Array.isArray(db[category]) ? db[category] : [];

        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue;

          if (entry.url) {
            const normalized = normalizeUrl(entry.url);
            if (normalized) trustedUrls.add(normalized);

            for (const id of extractIds(entry.url)) {
              trustedIds.add(id);
            }
          }

          if (entry.id !== undefined && entry.id !== null) {
            trustedIds.add(String(entry.id));
          }
        }
      }

      databaseReady = true;

      console.log('[InnerCircle] Trusted database loaded:', {
        friends: db.friends?.length || 0,
        groups: db.groups?.length || 0,
        following: db.following?.length || 0,
        urls: trustedUrls.size,
        ids: trustedIds.size,
        hasEntries: databaseHasEntries
      });

      if (settingsReady) {
        document.querySelectorAll(`[${ITEM_ATTR}]`).forEach(updatePostTrust);
        queueScan();
      }
    });
  }

  function isTrustedPost(post) {
    // Never classify posts when the database is empty.
    if (!databaseReady || !databaseHasEntries) return null;

    const links = Array.from(post.querySelectorAll('a[href]'));

    // Detect "Friend follows/follow Page" attribution.
    for (let i = 0; i < links.length - 1; i++) {
      let node = links[i].nextSibling;
      let textBetween = '';

      while (node && node !== links[i + 1]) {
        if (node.nodeType === Node.TEXT_NODE) {
          textBetween += node.textContent;
        }
        node = node.nextSibling;
      }

      if (/\bfollows?\b/i.test(textBetween)) {
        const pageLink = links[i + 1];
        const normalized = normalizeUrl(pageLink.href);

        if (normalized && trustedUrls.has(normalized)) return true;

        for (const id of extractIds(pageLink.href)) {
          if (trustedIds.has(id)) return true;
        }

        const pageName = (pageLink.innerText || pageLink.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .toLowerCase();

        if (pageName && trustedGroupNames.has(pageName)) return true;

        // The friend's profile alone must not trust this post.
        return false;
      }
    }

    // Normal URL, ID, and group-name matching.
    for (const link of links) {
      const normalized = normalizeUrl(link.href);

      if (normalized && trustedUrls.has(normalized)) return true;

      for (const id of extractIds(link.href)) {
        if (trustedIds.has(id)) return true;
      }

      const linkText = (link.innerText || link.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

      if (linkText && trustedGroupNames.has(linkText)) return true;
    }

    return false;
  }

  function removeTestUI(post) {
    post.querySelectorAll('.innercircle-hide-button').forEach(button => {
      button.remove();
    });

    if (post.dataset.innercircleChangedPosition === 'true') {
      post.style.removeProperty('position');
      delete post.dataset.innercircleChangedPosition;
    }
  }

  function addTestUI(post) {
    if (getComputedStyle(post).position === 'static') {
      post.style.setProperty('position', 'relative', 'important');
      post.dataset.innercircleChangedPosition = 'true';
    }

    let button = post.querySelector(':scope > .innercircle-hide-button');

    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'innercircle-hide-button';
      button.textContent = 'Hide';
      button.title = 'Hide this post';

      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        hidePost(post);
      });

      post.appendChild(button);
    }
  }

  function updatePostTrust(post) {
    if (!post.isConnected || !settingsReady || !databaseReady) return;

    const trusted = isTrustedPost(post);

    if (trusted === null) {
      post.removeAttribute(TRUST_ATTR);
      removeTestUI(post);
      return;
    }

    post.setAttribute(TRUST_ATTR, trusted ? 'trusted' : 'untrusted');

    if (testMode) {
      addTestUI(post);
      return;
    }

    removeTestUI(post);

    if (!trusted) {
      hidePost(post);
    }
  }

  function looksLikePost(element) {
    const rect = element.getBoundingClientRect();

    if (rect.width < 250 || rect.height < 100) return false;

    const text = (element.innerText || '').trim();
    const hasMedia = element.querySelector(
      'img, video, [role="img"], [data-ad-rendering-role]'
    );

    return text.length >= 40 || Boolean(hasMedia);
  }

  function findPostGroup() {
    const queue = [document.body];

    while (queue.length) {
      const parent = queue.shift();
      if (!parent) continue;

      const children = Array.from(parent.children);
      const groups = new Map();

      for (const child of children) {
        if (child.tagName !== 'DIV' || child.classList.length !== 1) {
          continue;
        }

        const className = child.classList[0];

        if (!groups.has(className)) groups.set(className, []);
        groups.get(className).push(child);
      }

      for (const [className, siblings] of groups) {
        if (siblings.length < 3) continue;

        const candidates = siblings.filter(looksLikePost);

        if (candidates.length >= 3) {
          return { parent, className };
        }
      }

      for (const child of children) queue.push(child);
    }

    return null;
  }

  function decoratePost(post) {
    if (!post.hasAttribute(ITEM_ATTR)) {
      post.setAttribute(ITEM_ATTR, '');
    }

    updatePostTrust(post);
  }

  function scan() {
    scanQueued = false;

    if (!settingsReady) return;

    if (!feedParent || !feedParent.isConnected) {
      feedParent = null;
      postClass = null;

      const found = findPostGroup();
      if (!found) return;

      feedParent = found.parent;
      postClass = found.className;
    }

    for (const child of Array.from(feedParent.children)) {
      if (
        child.tagName === 'DIV' &&
        child.classList.length === 1 &&
        child.classList[0] === postClass &&
        looksLikePost(child)
      ) {
        decoratePost(child);
      }
    }
  }

  function queueScan() {
    if (scanQueued) return;

    scanQueued = true;
    requestAnimationFrame(scan);
  }

  function applyModeToExistingPosts() {
    ensureStyles();

    document.querySelectorAll(`[${ITEM_ATTR}]`).forEach(post => {
      if (!testMode) {
        removeTestUI(post);
      }

      if (databaseReady) {
        updatePostTrust(post);
      }
    });

    queueScan();
  }

  const observer = new MutationObserver(queueScan);

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      if (changes.innerCircleDB) {
        loadDatabase();
      }

      if (changes[TEST_MODE_KEY]) {
        testMode = Boolean(changes[TEST_MODE_KEY].newValue);
        applyModeToExistingPosts();
      }
    });
  }

  // Load the saved mode before processing any posts.
  chrome.storage.local.get({ [TEST_MODE_KEY]: false }, result => {
    if (chrome.runtime.lastError) {
      console.error(
        '[InnerCircle] Could not load Test Mode setting:',
        chrome.runtime.lastError.message
      );
      testMode = false;
    } else {
      testMode = Boolean(result[TEST_MODE_KEY]);
    }

    settingsReady = true;
    ensureStyles();
    loadDatabase();
    scan();
  });
})();