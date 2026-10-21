// Clicking the toolbar icon opens the assistant in Chrome's side panel, which stays open
// while you click around the page and only closes with its X.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
