chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;

    chrome.storage.local.get({ enableTabDedup: true }, ({ enableTabDedup }) => {
        if (!enableTabDedup) return;

        const match = changeInfo.url.match(/^https:\/\/app\.labelbox\.com\/projects\/([^\/]+)\/data-rows\/c/);
        if (!match) return;

        const projectId = match[1];
        const projectRegex = new RegExp(`^https://app\\.labelbox\\.com/projects/${projectId}/data-rows/c`);

        chrome.tabs.query({}, (tabs) => {
            const tabsToClose = tabs
                .filter(t => t.id !== tabId && t.url && projectRegex.test(t.url))
                .map(t => t.id);

            if (tabsToClose.length > 0) {
                chrome.tabs.remove(tabsToClose);
            }
        });
    });
});
