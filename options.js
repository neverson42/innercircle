const status = document.getElementById("status");
const buildButton = document.getElementById("build");
const clearDatabaseButton = document.getElementById("clearDatabase");
const hiddenCount = document.getElementById("hiddenCount");
const resetHiddenCountButton = document.getElementById("resetHiddenCount");
const scrollingDistance = document.getElementById("scrollingDistance");

const testModeToggle = document.getElementById("testModeToggle");
const testModeStatus = document.getElementById("testModeStatus");
const TEST_MODE_KEY = "innerCircleTestMode";

const EMPTY_DATABASE = {
  friends: [],
  groups: [],
  following: []
};

let savedTestMode = false;

async function loadTestMode() {
  try {
    const data = await chrome.storage.local.get({
      [TEST_MODE_KEY]: false
    });

    savedTestMode = Boolean(data[TEST_MODE_KEY]);
    testModeToggle.checked = savedTestMode;
    updateTestModeStatus();
  } catch (error) {
    console.error("[InnerCircle] Could not load Test Mode:", error);
    testModeStatus.textContent = "Could not load setting.";
  }
}

function updateTestModeStatus() {
  testModeStatus.textContent = savedTestMode
    ? "ON — Testing highlights enabled."
    : "OFF — Untrusted posts are removed automatically.";
}

testModeToggle.addEventListener("change", async () => {
  const requestedMode = testModeToggle.checked;
  testModeToggle.disabled = true;
  testModeStatus.textContent = "Saving setting…";

  try {
    await chrome.storage.local.set({
      [TEST_MODE_KEY]: requestedMode
    });

    savedTestMode = requestedMode;
    updateTestModeStatus();
  } catch (error) {
    console.error("[InnerCircle] Could not save Test Mode:", error);
    testModeToggle.checked = savedTestMode;
    testModeStatus.textContent = "Could not save setting. Please try again.";
  } finally {
    testModeToggle.disabled = false;
  }
});

async function getDatabase() {
  const data = await chrome.storage.local.get([
    "innerCircleDB",
    "innerCircleLastRefresh"
  ]);

  return {
    db: { ...EMPTY_DATABASE, ...(data.innerCircleDB || {}) },
    lastRefresh: data.innerCircleLastRefresh || null
  };
}

function formatTotals(db) {
  return `Friends: ${db.friends.length}\n` +
         `Groups: ${db.groups.length}\n` +
         `Following: ${db.following.length}`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "Last refresh: Never";

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return "Last refresh: Unknown";

  return `Last refresh: ${date.toLocaleString()}`;
}

function formatDistance(pixels) {
  // Approximate CSS pixels at 96 pixels per inch.
  const inches = pixels / 96;
  const feet = inches / 12;
  const miles = feet / 5280;

  if (inches < 12) {
    const value = Math.round(inches);
    return `${value} ${value === 1 ? "inch" : "inches"}`;
  }

  if (feet < 1000) {
    const wholeFeet = Math.floor(feet);
    const remainingInches = Math.round(inches - wholeFeet * 12);

    if (remainingInches === 12) {
      const roundedFeet = wholeFeet + 1;
      return `${roundedFeet} ${roundedFeet === 1 ? "foot" : "feet"}`;
    }

    if (remainingInches === 0) {
      return `${wholeFeet} ${wholeFeet === 1 ? "foot" : "feet"}`;
    }

    return `${wholeFeet} ${wholeFeet === 1 ? "foot" : "feet"} ${remainingInches} ${remainingInches === 1 ? "inch" : "inches"}`;
  }

  if (miles < 10) {
    return `${miles.toFixed(2)} miles`;
  }

  return `${miles.toFixed(1)} miles`;
}

async function refreshHiddenCount() {
  const data = await chrome.storage.local.get({
    innerCircleHiddenPostCount: 0,
    innerCircleHiddenPostPixels: 0
  });

  const count = Math.max(
    0,
    Number(data.innerCircleHiddenPostCount) || 0
  );

  const pixels = Math.max(
    0,
    Number(data.innerCircleHiddenPostPixels) || 0
  );

  hiddenCount.textContent = count.toLocaleString();

  scrollingDistance.textContent =
    `That's ${formatDistance(pixels)} of scrolling you didn't have to do.`;
}

async function refreshStatus(message = "") {
  const { db, lastRefresh } = await getDatabase();

  const total =
    db.friends.length +
    db.groups.length +
    db.following.length;

  if (total === 0) {
    status.textContent =
      `${message ? message + "\n\n" : ""}` +
      "No saved database found.\n" +
      "Click Build Database to collect your Friends, Groups, and Following lists.";
    return;
  }

  status.textContent =
    `${message ? message + "\n\n" : ""}` +
    `${formatTotals(db)}\n\n` +
    formatTimestamp(lastRefresh);
}

buildButton.addEventListener("click", async () => {
  buildButton.disabled = true;
  clearDatabaseButton.disabled = true;
  status.textContent = "Building database. Please wait…";

  try {
    const result = await chrome.runtime.sendMessage({
      type: "BUILD_DATABASE"
    });

    if (!result || !result.ok) {
      throw new Error(
        result?.error || "No response from the background service."
      );
    }

    await refreshStatus(
      result.incomplete?.length
        ? `Build finished with incomplete categories: ${result.incomplete.join(", ")}. Previous saved data was preserved for those categories.`
        : "Database rebuilt successfully."
    );
  } catch (error) {
    await refreshStatus(`Build failed: ${error.message}`);
  } finally {
    buildButton.disabled = false;
    clearDatabaseButton.disabled = false;
  }
});

clearDatabaseButton.addEventListener("click", async () => {
  if (
    !confirm(
      "Clear your entire InnerCircle database?\n\n" +
      "This deletes your saved Friends, Groups, and Following lists. " +
      "You will need to build the database again before InnerCircle can " +
      "classify posts.\n\n" +
      "Your hidden-post totals and Test Mode setting will not be changed."
    )
  ) {
    return;
  }

  clearDatabaseButton.disabled = true;
  buildButton.disabled = true;
  status.textContent = "Clearing database…";

  try {
    await chrome.storage.local.remove([
      "innerCircleDB",
      "innerCircleLastRefresh",
      "innerCircleBuildProgress"
    ]);

    await refreshStatus("Database cleared.");
  } catch (error) {
    console.error("[InnerCircle] Could not clear database:", error);
    await refreshStatus(`Could not clear database: ${error.message}`);
  } finally {
    clearDatabaseButton.disabled = false;
    buildButton.disabled = false;
  }
});

resetHiddenCountButton.addEventListener("click", async () => {
  if (!confirm("Reset the hidden-post total and scrolling distance to zero?")) {
    return;
  }

  resetHiddenCountButton.disabled = true;

  try {
    await chrome.storage.local.set({
      innerCircleHiddenPostCount: 0,
      innerCircleHiddenPostPixels: 0
    });

    await refreshHiddenCount();
  } catch (error) {
    console.error("[InnerCircle] Could not reset hidden-post totals:", error);
  } finally {
    resetHiddenCountButton.disabled = false;
  }
});

// Refresh displayed values when storage changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes[TEST_MODE_KEY]) {
    savedTestMode = Boolean(changes[TEST_MODE_KEY].newValue);
    testModeToggle.checked = savedTestMode;
    updateTestModeStatus();
  }

  if (changes.innerCircleDB || changes.innerCircleLastRefresh) {
    refreshStatus().catch(console.error);
  }

  if (
    changes.innerCircleHiddenPostCount ||
    changes.innerCircleHiddenPostPixels
  ) {
    refreshHiddenCount().catch(console.error);
  }
});

// Initial page load.
loadTestMode();
refreshStatus().catch(console.error);
refreshHiddenCount().catch(console.error);