
const EMPTY_DATABASE = {
  friends: [],
  groups: [],
  following: []
};

const COLLECTION_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_MS = 6 * 1000;
const SCROLL_INTERVAL_MS = 1000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "DISCOVER_PROFILE") {
    discoverProfile()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "BUILD_DATABASE") {
    buildDatabase()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createTabSafely(options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chrome.tabs.create(options);
    } catch (error) {
      const transient =
        /cannot be edited right now|user may be dragging a tab/i.test(
          error.message || ""
        );

      if (!transient || attempt >= 5) throw error;
      await delay(attempt * 1000);
    }
  }
}

async function closeTabSafely(tabId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await chrome.tabs.remove(tabId);
      await delay(500);
      return;
    } catch (error) {
      if (/no tab with id/i.test(error.message || "")) return;

      const transient =
        /cannot be edited right now|user may be dragging a tab/i.test(
          error.message || ""
        );

      if (!transient || attempt === 5) return;
      await delay(attempt * 1000);
    }
  }
}

async function discoverProfile() {
  const windowId = await getFacebookWindowId();
  let tab;

  try {
    tab = await createTabSafely({
      windowId,
      url: "https://www.facebook.com/me/",
      active: true
    });

    const profileUrl = await waitForTab(tab.id, 30000);

    if (!profileUrl || !profileUrl.startsWith("https://www.facebook.com/")) {
      throw new Error("Facebook did not resolve to a profile page.");
    }

    const url = new URL(profileUrl);

    await chrome.storage.local.set({
      innerCircleIdentity: {
        profileUrl: url.href,
        userId: url.searchParams.get("id") || null,
        discoveredAt: new Date().toISOString()
      }
    });

    return { profileUrl: url.href };
  } finally {
    if (tab?.id !== undefined) {
      await closeTabSafely(tab.id);
    }
  }
}

async function buildDatabase() {
  const identity = await getInnerCircleIdentity();
  const windowId = await getFacebookWindowId();
  const base = identity.profileUrl.replace(/\/$/, "");

  const targets = [
    { category: "friends", url: `${base}/friends_all` },
    { category: "groups", url: "https://www.facebook.com/groups/joins/" },
    { category: "following", url: `${base}/following` }
  ];

  // Fresh snapshot: previous records are intentionally cleared.
  const db = {
    friends: [],
    groups: [],
    following: []
  };

  await chrome.storage.local.set({
    innerCircleDB: { ...db },
    innerCircleLastRefresh: null,
    innerCircleBuildProgress: {
      category: "Starting",
      phase: "starting",
      count: 0,
      updatedAt: Date.now()
    }
  });

  const counts = {};
  const totals = {};
  const errors = {};
  const incomplete = [];

  for (const target of targets) {
    let tab;

    try {
      await chrome.storage.local.set({
        innerCircleBuildProgress: {
          category: target.category,
          phase: "loading",
          count: 0,
          updatedAt: Date.now()
        }
      });

      tab = await createTabSafely({
        windowId,
        url: target.url,
        active: true
      });

      const finalUrl = await waitForTab(tab.id, 30000);

      if (!finalUrl || !finalUrl.startsWith("https://www.facebook.com/")) {
        throw new Error("Facebook did not load the expected page.");
      }

      await chrome.storage.local.set({
        innerCircleBuildProgress: {
          category: target.category,
          phase: "scrolling",
          count: 0,
          updatedAt: Date.now()
        }
      });

      // Groups continues using its original collector.
      // Only Friends and Following use the boundary-based collector.
      const isGroups = target.category === "groups";
      const collector = isGroups
        ? collectEntries
        : collectFriendOrFollowingEntries;

      const args = isGroups
        ? [
            target.category,
            COLLECTION_TIMEOUT_MS,
            IDLE_TIMEOUT_MS,
            SCROLL_INTERVAL_MS
          ]
        : [
            target.category,
            COLLECTION_TIMEOUT_MS,
            IDLE_TIMEOUT_MS,
            SCROLL_INTERVAL_MS,
            identity.profileUrl
          ];

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collector,
        args
      });

      const result = results?.[0]?.result;

      if (!result) {
        throw new Error("The collector returned no result.");
      }

      counts[target.category] = result.entries.length;

      if (!result.complete) {
        incomplete.push(target.category);
        errors[target.category] =
          `Collection incomplete: ${result.reason}. ` +
          "No partial records were saved.";
        totals[target.category] = 0;
        continue;
      }

      db[target.category] = result.entries;

      await chrome.storage.local.set({
        innerCircleDB: { ...db },
        innerCircleBuildProgress: {
          category: target.category,
          phase: "saved",
          count: result.entries.length,
          updatedAt: Date.now()
        }
      });

      totals[target.category] = result.entries.length;
    } catch (error) {
      errors[target.category] = error.message;
      incomplete.push(target.category);
      totals[target.category] = 0;
    } finally {
      if (tab?.id !== undefined) {
        await closeTabSafely(tab.id);
      }
    }
  }

  const lastRefresh = new Date().toISOString();

  await chrome.storage.local.set({
    innerCircleDB: { ...db },
    innerCircleLastRefresh: lastRefresh,
    innerCircleBuildProgress: {
      category: "Finished",
      phase: "finished",
      count: 0,
      updatedAt: Date.now()
    }
  });

  return {
    counts,
    totals,
    incomplete,
    errors,
    message: incomplete.length
      ? "Build finished with incomplete categories. Partial records were discarded."
      : "Database rebuilt successfully."
  };
}

/*
 * NEW: Friends and Following only.
 *
 * Finds the boundary using the previously saved profile URL.
 * Re-scans every link on every pass while scrolling.
 * Groups does not call this function.
 */

async function collectFriendOrFollowingEntries(
  category,
  maxRuntimeMs,
  idleTimeoutMs,
  scrollIntervalMs,
  profileUrl
) {
  if (category !== "friends" && category !== "following") {
    return {
      entries: [],
      complete: false,
      reason: "unsupported category for boundary-based collection"
    };
  }

  let savedProfile;

  try {
    savedProfile = new URL(profileUrl);
  } catch {
    return {
      entries: [],
      complete: false,
      reason: "the saved profile URL is invalid"
    };
  }

  if (savedProfile.hostname !== "www.facebook.com") {
    return {
      entries: [],
      complete: false,
      reason: "the saved profile URL is invalid"
    };
  }

  const profilePath = savedProfile.pathname.replace(/\/+$/, "");
  const boundaryPath =
    `${profilePath}/friends_with_upcoming_birthdays`.toLowerCase();

  const excluded = new Set([
    "me", "friends", "friends_all", "following", "followers",
    "groups", "watch", "marketplace", "gaming", "events",
    "messages", "notifications", "settings", "help", "privacy",
    "policies", "photo", "photos", "reel", "reels", "stories",
    "search", "login", "logout", "bookmarks", "saved", "directory",
    "friends_with_upcoming_birthdays"
  ]);

  const found = new Map();
  const startedAt = Date.now();

  let lastProgressAt = Date.now();
  let previousHeight = -1;
  let previousScrollTop = -1;
  let previousCount = 0;
  let boundarySeen = false;
  let completed = false;

  function getScrollState() {
    const candidates = [];

    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);

      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 40 &&
        element.clientHeight > 100 &&
        element.clientWidth > 150
      ) {
        candidates.push(element);
      }
    }

    candidates.sort(
      (a, b) =>
        b.clientHeight * b.clientWidth -
        a.clientHeight * a.clientWidth
    );

    const element =
      candidates[0] ||
      document.scrollingElement ||
      document.documentElement;

    return {
      element,
      top: element.scrollTop,
      height: element.scrollHeight,
      clientHeight: element.clientHeight,
      atBottom:
        element.scrollTop + element.clientHeight >=
        element.scrollHeight - 20
    };
  }

  function scanAllLinks() {
    const links = [...document.querySelectorAll("a[href]")];
    let boundaryIndex = -1;

    for (let i = 0; i < links.length; i++) {
      try {
        const url = new URL(links[i].href, location.origin);

        if (
          url.hostname === "www.facebook.com" &&
          url.pathname.replace(/\/+$/, "").toLowerCase() === boundaryPath
        ) {
          boundaryIndex = i;
          break;
        }
      } catch {
        // Ignore malformed links.
      }
    }

    if (boundaryIndex >= 0) {
      boundarySeen = true;
    }

    // Before the boundary is found, do not collect arbitrary page links.
    if (!boundarySeen) {
      return;
    }

    // If the boundary is still present, use it to delimit the list.
    // If Facebook virtualized it out of the DOM, scan current links and
    // retain only eligible profiles, deduplicating against earlier scans.
    const startIndex = boundaryIndex >= 0 ? boundaryIndex + 1 : 0;

    for (let i = startIndex; i < links.length; i++) {
      const link = links[i];
      const name = (
        link.innerText ||
        link.getAttribute("aria-label") ||
        ""
      ).trim().replace(/\s+/g, " ");

      if (
        !name ||
        name.length > 150 ||
        /mutual friends?$/i.test(name) ||
        /friends with upcoming birthdays/i.test(name)
      ) {
        continue;
      }

      let url;

      try {
        url = new URL(link.href, location.origin);
      } catch {
        continue;
      }

      if (url.hostname !== "www.facebook.com") continue;

      let id = null;
      let key = null;
      const parts = url.pathname.split("/").filter(Boolean);

      if (/^\/profile\.php\/?$/i.test(url.pathname)) {
        id = url.searchParams.get("id");
        if (!id) continue;

        key = `${url.origin}/profile.php?id=${encodeURIComponent(id)}`;
      } else if (parts.length === 1) {
        const username = parts[0];

        if (excluded.has(username.toLowerCase())) continue;

        key = `${url.origin}/${username.toLowerCase()}`;
      } else {
        continue;
      }

      // Never add the account being scanned as its own friend/follow.
      if (
        url.pathname.replace(/\/+$/, "").toLowerCase() === profilePath.toLowerCase()
      ) {
        continue;
      }

      if (!found.has(key)) {
        found.set(key, {
          name,
          url: url.href,
          id,
          category
        });
      }
    }
  }

  while (Date.now() - startedAt < maxRuntimeMs) {
    scanAllLinks();

    await chrome.storage.local.set({
      innerCircleBuildProgress: {
        category,
        phase: boundarySeen ? "collecting" : "finding-boundary",
        count: found.size,
        updatedAt: Date.now()
      }
    });

    const before = getScrollState();
    const step = Math.max(200, Math.floor(before.clientHeight * 0.7));

    before.element.scrollTop = Math.min(
      before.top + step,
      before.element.scrollHeight
    );

    window.scrollBy(0, step);

    await new Promise(resolve => setTimeout(resolve, scrollIntervalMs));

    // Capture newly rendered links before checking whether the page moved.
    scanAllLinks();

    const state = getScrollState();
    const pageHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
    const height = Math.max(state.height, pageHeight);

    const moved =
      state.top !== previousScrollTop ||
      before.top !== state.top;

    const heightChanged = height !== previousHeight;
    const countChanged = found.size !== previousCount;

    if (moved || heightChanged || countChanged) {
      lastProgressAt = Date.now();
    }

    previousScrollTop = state.top;
    previousHeight = height;
    previousCount = found.size;

    if (
      boundarySeen &&
      state.atBottom &&
      Date.now() - lastProgressAt >= idleTimeoutMs
    ) {
      completed = true;
      break;
    }

    if (!moved && !state.atBottom) {
      window.scrollBy(0, Math.max(200, window.innerHeight * 0.7));
    }
  }

  if (!boundarySeen) {
    return {
      entries: [],
      complete: false,
      reason:
        "the saved profile's friends_with_upcoming_birthdays boundary was not found"
    };
  }

  const entries = [...found.values()];

  if (!completed) {
    return {
      entries,
      complete: false,
      reason: "the maximum collection time was reached before scrolling stabilized"
    };
  }

  if (entries.length === 0) {
    return {
      entries: [],
      complete: false,
      reason: "the boundary was found, but no profile links were collected"
    };
  }

  return {
    entries,
    complete: true,
    reason: "scrolling stabilized and accumulated profile links were collected"
  };
}

/*
 * ORIGINAL GROUPS COLLECTOR — unchanged.
 */
async function collectEntries(
  category,
  maxRuntimeMs,
  idleTimeoutMs,
  scrollIntervalMs
) {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let previousHeight = -1;
  let previousScrollTop = -1;
  let completed = false;

  function getScrollers() {
    const candidates = [];

    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);

      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 40 &&
        element.clientHeight > 100 &&
        element.clientWidth > 150
      ) {
        candidates.push(element);
      }
    }

    candidates.sort(
      (a, b) =>
        b.clientHeight * b.clientWidth -
        a.clientHeight * a.clientWidth
    );

    return candidates;
  }

  function getScrollerState() {
    const scrollers = getScrollers();
    const element =
      scrollers[0] ||
      document.scrollingElement ||
      document.documentElement;

    return {
      element,
      top: element.scrollTop,
      height: element.scrollHeight,
      clientHeight: element.clientHeight,
      atBottom:
        element.scrollTop + element.clientHeight >=
        element.scrollHeight - 20
    };
  }

  function scrollIncrementally() {
    const state = getScrollerState();
    const element = state.element;
    const step = Math.max(200, Math.floor(state.clientHeight * 0.7));

    element.scrollTop = Math.min(
      state.top + step,
      element.scrollHeight
    );

    window.scrollBy(0, step);
  }

  // Original Groups scrolling behavior.
  while (Date.now() - startedAt < maxRuntimeMs) {
    scrollIncrementally();
    await new Promise(resolve => setTimeout(resolve, scrollIntervalMs));

    const state = getScrollerState();

    const pageHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );

    const height = Math.max(state.height, pageHeight);
    const moved = state.top !== previousScrollTop;
    const heightChanged = height !== previousHeight;

    if (moved || heightChanged) {
      lastProgressAt = Date.now();
    }

    previousScrollTop = state.top;
    previousHeight = height;

    if (
      state.atBottom &&
      Date.now() - lastProgressAt >= idleTimeoutMs
    ) {
      completed = true;
      break;
    }

    if (!moved && !state.atBottom) {
      window.scrollBy(0, Math.max(200, window.innerHeight * 0.7));
    }
  }

  if (!completed) {
    return {
      entries: [],
      complete: false,
      reason: "the maximum collection time was reached before the bottom stabilized"
    };
  }

  // Original Groups DOM extraction behavior.
  const found = new Map();

  const excluded = new Set([
    "me", "friends", "friends_all", "following", "followers",
    "groups", "watch", "marketplace", "gaming", "events",
    "messages", "notifications", "settings", "help", "privacy",
    "policies", "photo", "photos", "reel", "reels", "stories",
    "search", "login", "logout", "bookmarks", "saved", "directory"
  ]);

  for (const link of document.querySelectorAll("a[href]")) {
    
    let name = (
      link.innerText ||
      link.getAttribute("aria-label") ||
      ""
    ).trim().replace(/\s+/g, " ");

    if (category === "groups") {
      name = name.replace(/\s+Last active\b[\s\S]*$/i, "").trim();
    }

    if (!name || name.length > 150) continue;

    let url;

    try {
      url = new URL(link.href, location.origin);
    } catch {
      continue;
    }

    if (url.hostname !== "www.facebook.com") continue;

    const path = url.pathname;
    let id = null;
    let key = null;
    let valid = false;

    if (category === "friends" || category === "following") {
      if (/^\/profile\.php\/?$/.test(path)) {
        id = url.searchParams.get("id");
        valid = Boolean(id);

        if (id) {
          key = `${url.origin}/profile.php?id=${encodeURIComponent(id)}`;
        }
      } else if (/^\/[^/]+\/?$/.test(path)) {
        const segment = path.split("/").filter(Boolean)[0] || "";

        valid = !excluded.has(segment.toLowerCase());

        if (valid) {
          key = `${url.origin}${path.replace(/\/+$/, "").toLowerCase()}`;
        }
      }
    } else if (category === "groups") {
      const match = path.match(/^\/groups\/([^/]+)\/?$/);

      const notificationParams = [
        "notif_id",
        "notif_t",
        "post_id",
        "comment_id",
        "reply_comment_id",
        "multi_permalinks"
      ];

      if (notificationParams.some(param => url.searchParams.has(param))) {
        continue;
      }

      valid = Boolean(match) &&
        !["joins", "feed", "discover", "create"].includes(
          match[1].toLowerCase()
        );

      if (match) {
        id = match[1];
        key = `${url.origin}/groups/${match[1].toLowerCase()}`;
        url.search = "";
      }
    }

    if (!valid || !key) continue;

    if (!found.has(key)) {
      found.set(key, {
        name,
        url: url.href,
        id,
        category
      });
    }
  }

  const entries = [...found.values()];

  await chrome.storage.local.set({
    innerCircleBuildProgress: {
      category,
      phase: "collected",
      count: entries.length,
      updatedAt: Date.now()
    }
  });

  if (entries.length === 0) {
    return {
      entries: [],
      complete: false,
      reason: "the DOM scan found no matching entries"
    };
  }

  return {
    entries,
    complete: true,
    reason: "scrolling completed and DOM scan finished"
  };
}

async function getFacebookWindowId() {
  const tabs = await chrome.tabs.query({
    url: "https://www.facebook.com/*"
  });

  const facebookTab = tabs.find(
    tab => tab.active && tab.windowId !== undefined
  ) || tabs.find(tab => tab.windowId !== undefined);

  if (facebookTab) return facebookTab.windowId;

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (activeTab?.windowId !== undefined) return activeTab.windowId;

  const window = await chrome.windows.getLastFocused();
  return window.id;
}

function waitForTab(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeout);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const timeout = setTimeout(() => {
      finish(reject, new Error("Timed out waiting for Facebook to load."));
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve, tab.url);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId)
      .then(tab => {
        if (tab.status === "complete" && tab.url) {
          finish(resolve, tab.url);
        }
      })
      .catch(error => finish(reject, error));
  });
}

async function getInnerCircleIdentity() {
  const data = await chrome.storage.local.get("innerCircleIdentity");
  const profileUrl = data.innerCircleIdentity?.profileUrl;

  if (!profileUrl) {
    throw new Error(
      "No Facebook profile saved. Discover your profile before building the database."
    );
  }

  const url = new URL(profileUrl);

  if (url.hostname !== "www.facebook.com") {
    throw new Error("The saved profile URL is not a Facebook URL.");
  }

  return {
    profileUrl: url.href,
    userId:
      data.innerCircleIdentity.userId ||
      url.searchParams.get("id") ||
      null
  };
}
