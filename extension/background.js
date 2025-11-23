// --- Constants and Configuration ---
// This placeholder will be replaced by your build script
const API_URL = '__API_URI_PLACEHOLDER__';
// This placeholder will be replaced by your build script
const API_KEY = '__API_KEY_PLACEHOLDER__';
const CACHE_DURATION_MINUTES = 60 * 24; // Cache data for 24 hours

/**
 * Authenticates the user with Supabase via Google OAuth.
 * @param {boolean} interactive - Whether to show a prompt if the user isn't logged in.
 * @returns {Promise<string|null>} The access token (JWT) or null.
 */
async function authenticate(interactive = false) {
    return runInExtensionContext(async () => {
        try {
            const redirectUrl = chrome.identity.getRedirectURL();
            const supabaseUrl = getSupabaseBaseUrl(API_URL);
            
            // Construct the Supabase OAuth URL
            const authUrl = new URL(`${supabaseUrl}/auth/v1/authorize`);
            authUrl.searchParams.set('provider', 'google');
            authUrl.searchParams.set('redirect_to', redirectUrl);

            // Launch the auth flow
            const responseUrl = await chrome.identity.launchWebAuthFlow({
                url: authUrl.toString(),
                interactive: interactive
            });

            if (!responseUrl) return null;

            // Extract the token from the hash fragment (#access_token=...)
            const url = new URL(responseUrl);
            const params = new URLSearchParams(url.hash.substring(1)); // Remove the '#'
            const accessToken = params.get('access_token');

            if (accessToken) {
                // Store token securely
                await chrome.storage.local.set({ 'supabase_token': accessToken });
                return accessToken;
            }
            return null;

        } catch (error) {
            console.warn('Authentication failed:', error);
            return null;
        }
    }, Promise.resolve(null)); // Fallback for tests
}


/**
 * Parses a URL string and returns domain information, including app store detection.
 * Handles subdomains and invalid URLs gracefully.
 * @param {string | null | undefined} urlString The URL to parse.
 * @returns {object | null} An object containing domain information or null if the URL is invalid.
 */
function getDomainInfo(urlString) {
    if (!urlString || typeof urlString !== 'string') {
        return null;
    }
    try {
        const url = new URL(urlString);
        const hostnameParts = url.hostname.split('.');

        let appID = null;
        let isAppStore = false;
        let appStoreName = null; // Variable to hold the specific store name
        
        try {
            switch (url.hostname) {
                case 'apps.apple.com':
                    isAppStore = true;
                    appStoreName = 'Apple App Store';
                    if (url.pathname.includes('/app/')) {
                        const applePathParts = url.pathname.split("/");
                        appID = applePathParts[applePathParts.length - 1];
                    }
                    break;
                case 'chromewebstore.google.com':
                    isAppStore = true;
                    appStoreName = 'Chrome Web Store';
                    const chromePathParts = url.pathname.split("/");
                    if (chromePathParts.length > 1 && chromePathParts[1] === 'detail') {
                        appID = chromePathParts[chromePathParts.length - 1];
                    }
                    break;
                case 'play.google.com':
                    isAppStore = true;
                    appStoreName = 'Google Play Store';
                    if (url.pathname.startsWith('/store/apps/details')) {
                        appID = url.searchParams.get("id");
                    }
                    break;
                case 'workspace.google.com':
                    isAppStore = true;
                    appStoreName = 'Google Workspace Marketplace';
                    const workspacePathParts = url.pathname.split("/");
                    if (workspacePathParts.length > 2 && workspacePathParts[1] === 'marketplace' && workspacePathParts[2] === 'app') {
                        const potentialAppID = workspacePathParts[workspacePathParts.length - 1];
                        if (/^\d+$/.test(potentialAppID)) {
                            appID = potentialAppID;
                        }
                    }
                    break;
            }
        } catch (error) {
            console.warn(`Could not parse the path to determine app-id: ${urlString}`);
            console.warn(error)
            // Don't return null here, as the base domain info is still valid.
        }

        let hostnameForMatching;
        if (isAppStore) {
            // Use full hostname for app stores
            hostnameForMatching = url.hostname; 
        } else {
            // otherwise use primary domain only
            if (hostnameParts.length > 1) {
                hostnameForMatching = hostnameParts.slice(-2).join('.');
            } else {
                // or handle TOP-LEVEL-DOMAIN only.... rare
                hostnameForMatching = url.hostname;
            }
        }

        return {
            fullHostname: url.hostname,
            hostname: hostnameForMatching, // This is what's used for matching
            isInstalled: appID !== null,
            appID: appID,
            isAppStore: isAppStore,
            appStoreName: appStoreName // Return the specific store name
        };
    } catch (error) {
        console.warn(`Could not parse invalid URL: ${urlString}`);
        console.warn(error);
        return null;
    }
}

/**
 * Fetches the complete DPA list from the API.
 * NOW UPDATED: Uses Bearer token.
 */
async function fetchDpaData() {
    // 1. Try to get existing token from storage
    let { supabase_token } = await runInExtensionContext(
        () => chrome.storage.local.get('supabase_token'), 
        { supabase_token: null }
    );

    // 2. If no token, try to authenticate silently (non-interactive)
    if (!supabase_token) {
        console.log('No token found, attempting silent login...');
        supabase_token = await authenticate(false);
    }

    if (!supabase_token) {
        console.error('User is not authenticated. Cannot fetch DPA list.');
        // Optional: Notify user they need to sign in (e.g., update icon badge)
        return null;
    }

    const headers = new Headers({ 
        'apikey': API_KEY, 
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${supabase_token}` // Add the Bearer token
    });

    try {
        let response = await fetch(API_URL, { method: 'GET', headers: headers });
        
        // 3. Handle Token Expiration (401 Unauthorized)
        if (response.status === 401) {
            console.log('Token expired or invalid. Attempting refresh...');
            // Force interactive login to get a fresh token
            supabase_token = await authenticate(true); 
            if (supabase_token) {
                headers.set('Authorization', `Bearer ${supabase_token}`);
                response = await fetch(API_URL, { method: 'GET', headers: headers });
            }
        }

        if (!response.ok) {
            console.error(`API Error: ${response.status} ${response.statusText}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('Network or fetch error:', error);
        return null;
    }
}

/**
 * Gets DPA data, prioritizing cache, and fetches new data if cache is stale or missing.
 */
async function getAndUpdateDpaList() {
    const now = new Date().getTime();
    const result = await chrome.storage.local.get(['dpaList', 'lastFetch']);

    if (result.dpaList && result.lastFetch && (now - result.lastFetch < CACHE_DURATION_MINUTES * 60 * 1000)) {
        console.log('Using cached DPA list.');
        return result.dpaList;
    }

    console.log('Cache stale or missing. Fetching new DPA list.');
    const dpaList = await fetchDpaData();
    if (dpaList) {
        await chrome.storage.local.set({ dpaList: dpaList, lastFetch: now });
        return dpaList;
    }
    return result.dpaList || null;
}


// --- Extension Logic ---

/**
 * Determines a single, overall status from the detailed site information.
 * @param {object} siteInfo - The data object for a specific site from the API.
 * @returns {string} The simplified status key (e.g., 'approved', 'denied', 'staff_only').
 */
function determineOverallStatus(siteInfo) {
    const { current_tl_status, current_dpa_status } = siteInfo;

    // Denied takes precedence
    if (current_tl_status === 'Rejected') {
        return 'denied';
    }
    if (current_dpa_status === 'Denied') {
        return 'staff_only'; // Per YAML logic
    }

    // Approved statuses
    const isApproved = (current_tl_status === 'Approved' || current_tl_status === 'Not Required');
    const isReceived = (current_dpa_status === 'Received' || current_dpa_status === 'Not Required');

    if (isApproved && isReceived) {
        return 'approved';
    }

    // All other cases are considered pending
    return 'pending';
}

/**
 * Updates the extension icon based on the site's status.
 * @param {string} status - The simplified status key.
 * @param {number} tabId - The ID of the tab to update.
 * @param {boolean} isInstalled - A flag to indicate if this is an installed app
 */
function updateIcon(status, tabId, isInstalled) {
    let iconPath = '';
    switch (status) {
        case 'approved':   iconPath = "images/icon-green-circle.png"; break;
        case 'denied':     iconPath = "images/icon-red-x.png"; break;
        case 'staff_only': iconPath = "images/icon-yellow-triangle.png"; break;
        case 'pending':    iconPath = "images/icon-orange-square.png"; break;
        case 'unlisted':   iconPath = "images/icon-purple-diamond.png"; break;
        default:           iconPath = "images/icon-neutral48.png"; break;
    }
    chrome.action.setIcon({ path: { "48": iconPath }, tabId: tabId });

    if (isInstalled){
        chrome.action.setBadgeText({ text: '⇲', tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#ebebeb', tabId: tabId });
    } else {
        chrome.action.setBadgeText({ text: '', tabId: tabId }); // Clear badge
    }
}

/**
 * Main handler for tab updates.
 */
async function handleTabUpdate(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete' || !tab.url || !tab.url.startsWith('http')) {
        return;
    }

    const tabDomainInfo = getDomainInfo(tab.url);
    if (!tabDomainInfo) { // If the current tab's URL is invalid for some reason
        updateIcon('neutral', tabId, false);
        return;
    }

    const dpaList = await getAndUpdateDpaList();
    if (!dpaList) {
        console.log('No DPA list available to check against.');
        updateIcon('neutral', tabId, tabDomainInfo.isInstalled);
        return;
    }
    
    let siteInfo = null;
    // Find the site by matching the app ID or hostname.
    if (tabDomainInfo.isInstalled){
        siteInfo = dpaList.find(site => {
            const siteDomainInfo = getDomainInfo(site.resource_link);
            return siteDomainInfo && siteDomainInfo.isInstalled && siteDomainInfo.appID === tabDomainInfo.appID;
        });
    } else if (!tabDomainInfo.isAppStore) { // Only match hostname if it's NOT a generic app store page
        siteInfo = dpaList.find(site => {
            const siteDomainInfo = getDomainInfo(site.resource_link);
            return siteDomainInfo && !siteDomainInfo.isInstalled && siteDomainInfo.hostname === tabDomainInfo.hostname;
        });
    }

    if (siteInfo) {
        const overallStatus = determineOverallStatus(siteInfo);
        console.log(`Site found: ${tabDomainInfo.hostname}, Status: ${overallStatus}`);
        updateIcon(overallStatus, tabId, tabDomainInfo.isInstalled);
    } else {
        console.log(`Site not found in DPA list: ${tabDomainInfo.hostname}`);
        updateIcon('unlisted', tabId, tabDomainInfo.isInstalled);
    }
}


// --- Event Listeners ---
chrome.tabs.onUpdated.addListener(handleTabUpdate);
chrome.runtime.onStartup.addListener(getAndUpdateDpaList);
chrome.runtime.onInstalled.addListener(getAndUpdateDpaList);
chrome.alarms.create('refreshDpaList', { delayInMinutes: 1, periodInMinutes: CACHE_DURATION_MINUTES });

function handleAlarm(alarm) {
    if (alarm.name === 'refreshDpaList') {
        console.log('Periodic alarm triggered. Refreshing DPA list.');
        getAndUpdateDpaList();
    }
}
chrome.alarms.onAlarm.addListener(handleAlarm);

// --- Message Listener for Popup ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getSiteInfoForUrl") {
        // This is an async wrapper to allow using await inside the listener
        (async () => {
            const domainInfo = getDomainInfo(request.url);
            if (!domainInfo) {
                sendResponse({ error: 'Invalid URL.' });
                return;
            }

            const { dpaList } = await chrome.storage.local.get('dpaList');
            if (!dpaList) {
                sendResponse({ error: 'DPA data not yet loaded.' });
                return;
            }

            let siteInfo = null;
            if (domainInfo.isInstalled){
                siteInfo = dpaList.find(site => {
                    const siteDomainInfo = getDomainInfo(site.resource_link);
                    return siteDomainInfo && siteDomainInfo.isInstalled && siteDomainInfo.appID === domainInfo.appID;
                });
            } else if (!domainInfo.isAppStore) {
                siteInfo = dpaList.find(site => {
                    const siteDomainInfo = getDomainInfo(site.resource_link);
                    return siteDomainInfo && !siteDomainInfo.isInstalled && siteDomainInfo.hostname === domainInfo.hostname;
                });
            }

            // Send the final data back to the popup
            sendResponse({ siteInfo, domainInfo });
        })();

        return true; // Required to indicate you will send a response asynchronously
    }
});