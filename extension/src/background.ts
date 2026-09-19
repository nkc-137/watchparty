/**
 * Service worker. Currently minimal — the socket lives in the content script
 * (it needs to co-exist with the page and DOM overlay). Kept as an explicit
 * entry point for future needs (badge text, notifications, room links).
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log("Watch Party extension installed");
});
