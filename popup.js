const hiddenCount = document.getElementById("hiddenCount");
const scrollingDistance = document.getElementById("scrollingDistance");

function formatDistance(pixels) {
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

    const feetText =
      `${wholeFeet} ${wholeFeet === 1 ? "foot" : "feet"}`;

    if (remainingInches === 0) return feetText;

    return `${feetText} ${remainingInches} ${
      remainingInches === 1 ? "inch" : "inches"
    }`;
  }

  if (miles < 10) {
    return `${miles.toFixed(2)} miles`;
  }

  return `${miles.toFixed(1)} miles`;
}

async function refreshTotals() {
  hiddenCount.textContent = "Loading…";
  scrollingDistance.textContent = "";

  try {
    // Read storage every time the popup opens.
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

    hiddenCount.textContent =
      `${count.toLocaleString()} ${count === 1 ? "post" : "posts"} removed`;

    scrollingDistance.textContent =
      `That's ${formatDistance(pixels)} of scrolling!`;
  } catch (error) {
    console.error("[InnerCircle] Could not load hidden-post totals:", error);
    hiddenCount.textContent = "Totals unavailable";
    scrollingDistance.textContent = "Could not load scrolling savings.";
  }
}

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshTotals();
  }
});

refreshTotals();