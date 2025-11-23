document.addEventListener('DOMContentLoaded', () => {
    // Get references to the HTML elements we need to update
    const statusText = document.getElementById('status-text');
    const tlStatus = document.getElementById('tl-status');
    const dpaStatus = document.getElementById('dpa-status');
    const isAppText = document.getElementById('is-app-text');

    // Get the current tab to determine its URL
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url) {
            statusText.textContent = 'No active tab found.';
            return;
        }

        // Send a message to the background script to get all necessary info for this URL
        chrome.runtime.sendMessage({ action: "getSiteInfoForUrl", url: tab.url }, (response) => {
            if (chrome.runtime.lastError) {
                statusText.textContent = 'Error: Could not connect to the extension.';
                console.error(chrome.runtime.lastError.message);
                return;
            }
            
            if (response.error) {
                 statusText.textContent = response.error;
                 return;
            }

            const { siteInfo, domainInfo } = response;

            // --- Primary Display Logic ---

            // First, always display the app store source if it's an installed app.
            if (domainInfo && domainInfo.isInstalled) {
                const sourceText = domainInfo.appStoreName
                    ? `the ${domainInfo.appStoreName}.`
                    : 'an unknown source.';
                isAppText.textContent = `Installed from ${sourceText}`;
            } else {
                isAppText.textContent = '';
            }

            // Next, display the DPA status information
            if (siteInfo) {
                // If a match is found in the district list
                statusText.textContent = siteInfo.software_name;
                tlStatus.textContent = `T&L: ${siteInfo.current_tl_status || 'N/A'}`;
                dpaStatus.textContent = `DPA: ${siteInfo.current_dpa_status || 'N/A'}`;
            } else {
                // If no match is found
                statusText.textContent = 'This site is not in the district list.';
                tlStatus.textContent = 'Recommend for review submission.';
                dpaStatus.textContent = '';
            }
        });
    });
});

