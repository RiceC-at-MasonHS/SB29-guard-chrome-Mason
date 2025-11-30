// --- Constants and Configuration ---

// User-Agent header for API requests.
const USER_AGENT = 'SB29-guard-chrome';

/**
 * Placeholders for the Supabase, replaced at build time.
 * @type {string}
 */
const API_URL = '__API_URI_PLACEHOLDER__';
const API_KEY = '__API_KEY_PLACEHOLDER__';
const API_HOST = '__API_HOST_PLACEHOLDER__';

// Cache duration for the DPA list in minutes. (Set to 24 hours).
const CACHE_DURATION_MINUTES = 60 * 24;

/**
 * A utility function to ensure that Chrome extension APIs are only called when running as an extension.
 * This prevents errors during testing or in other non-extension environments.
 *
 * @param {Function} callback - The function to execute if in an extension context.
 * @param {*} [fallback=undefined] - The value to return if not in an extension context.
 * @returns {*} The result of the callback or the fallback value.
 */
function runInExtensionContext(callback, fallback) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        return callback();
    }
    return fallback;
}

/**
 * Initiates Google OAuth flow to authenticate the user with Supabase.
 * It retrieves an access token and stores it in local storage.
 *
 * @param {boolean} [interactive=false] - If true, the auth prompt will be shown to the user. If false, it will fail silently if the user is not signed in.
 * @returns {Promise<string|null>} A promise that resolves with the Supabase access token (JWT) on success, or null on failure.
 */
async function authenticate(interactive = false) {
    return runInExtensionContext(async () => {
        try {
            const redirectUrl = chrome.identity.getRedirectURL();
            
            // Construct the Supabase OAuth URL using the injected API_HOST
            const authUrl = new URL(`${API_HOST}/auth/v1/authorize`);
            authUrl.searchParams.set('provider', 'google');
            authUrl.searchParams.set('redirect_to', redirectUrl);

            // Launch the web authentication flow
            const responseUrl = await chrome.identity.launchWebAuthFlow({
                url: authUrl.toString(),
                interactive: interactive
            });

            if (!responseUrl) {
                console.warn('Authentication flow was cancelled or failed.');
                return null;
            }

            // Extract the access token from the URL fragment
            const url = new URL(responseUrl);
            const params = new URLSearchParams(url.hash.substring(1)); // Remove the leading '#'
            const accessToken = params.get('access_token');

            if (accessToken) {
                await chrome.storage.local.set({ 'supabase_token': accessToken });
                console.log('Successfully authenticated and stored token.');
                return accessToken;
            }
            
            console.warn('Authentication succeeded, but no access token was found in the response.');
            return null;

        } catch (error) {
            // This can happen if the user closes the auth window
            console.warn('Authentication failed:', error);
            return null;
        }
    }, Promise.resolve(null)); // Fallback for test environments
}

/**
 * Parses a URL string to extract detailed domain and app store information.
 * It identifies the primary domain, and for app store URLs, it extracts the application ID.
 *
 * @param {string | null | undefined} urlString - The URL to parse.
 * @returns {{fullHostname: string, hostname: string, isInstalled: boolean, appID: string|null, isAppStore: boolean, appStoreName: string|null}|null} 
 *          An object with parsed URL details, or null if the URL is invalid.
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
        let appStoreName = null;
        
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
                        // Ensure the extracted ID is a number, as workspace apps use numeric IDs
                        if (/^\d+$/.test(potentialAppID)) {
                            appID = potentialAppID;
                        }
                    }
                    break;
            }
        } catch (error) {
            console.warn(`Could not parse app store path for app-id: ${urlString}`, error);
            // Continue as the base domain info is still useful
        }

        let hostnameForMatching;
        if (isAppStore) {
            // For app stores, the full hostname is more specific for matching
            hostnameForMatching = url.hostname; 
        } else {
            // For regular websites, use the primary domain (e.g., 'google.com' from 'sub.google.com')
            if (hostnameParts.length > 1) {
                hostnameForMatching = hostnameParts.slice(-2).join('.');
            } else {
                // Handle top-level domains or localhost
                hostnameForMatching = url.hostname;
            }
        }

        return {
            fullHostname: url.hostname,
            hostname: hostnameForMatching,
            isInstalled: appID !== null,
            appID: appID,
            isAppStore: isAppStore,
            appStoreName: appStoreName
        };
    } catch (error) {
        console.warn(`Could not parse invalid URL: ${urlString}`, error);
        return null;
    }
}

/**
 * Fetches the complete DPA (Data Processing Agreement) list from the Supabase API.
 * It handles authentication by retrieving a stored token or initiating a new auth flow.
 * It also includes logic to refresh an expired token.
 *
 * @returns {Promise<object[]|null>} A promise that resolves to an array of DPA data objects, or null on failure.
 */
async function fetchDpaData() {
    // 1. Try to get existing token from storage
    let { supabase_token } = await runInExtensionContext(
        () => chrome.storage.local.get('supabase_token'), 
        { supabase_token: null }
    );

    // 2. If no token, attempt a silent (non-interactive) authentication
    if (!supabase_token) {
        console.log('No token found, attempting silent authentication...');
        supabase_token = await authenticate(false);
    }

    // If still no token, we cannot proceed
    if (!supabase_token) {
        console.error('User is not authenticated. Cannot fetch DPA list.');
        return null;
    }

    const headers = new Headers({ 
        'apikey': API_KEY, 
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${supabase_token}`
    });

    try {
        let response = await fetch(API_URL, { method: 'GET', headers: headers });
        
        // 3. If the token is expired (401), attempt an interactive authentication to refresh it
        if (response.status === 401) {
            console.log('Token expired or invalid. Forcing interactive authentication...');
            supabase_token = await authenticate(true); 
            
            if (supabase_token) {
                // Retry the fetch with the new token
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
        console.error('Network or fetch error while getting DPA list:', error);
        return null;
    }
}

/**
 * Retrieves the DPA list, using a cached version if available and not stale.
 * If the cache is missing or expired, it fetches a fresh list from the API and updates the cache.
 *
 * @returns {Promise<object[]|null>} A promise that resolves to the DPA list from cache or API, or null if unavailable.
 */
async function getAndUpdateDpaList() {
    const now = new Date().getTime();
    const result = await runInExtensionContext(
        () => chrome.storage.local.get(['dpaList', 'lastFetch']),
        { dpaList: null, lastFetch: null }
    );

    // Check if a valid, non-stale cache exists
    if (result.dpaList && result.lastFetch && (now - result.lastFetch < CACHE_DURATION_MINUTES * 60 * 1000)) {
        console.log('Using cached DPA list.');
        return result.dpaList;
    }

    console.log('Cache is stale or missing. Fetching new DPA list from API.');
    const dpaList = await fetchDpaData();
    
    if (dpaList) {
        // If fetch is successful, update cache
        await runInExtensionContext(
            () => chrome.storage.local.set({ dpaList: dpaList, lastFetch: now }),
            Promise.resolve()
        );
        console.log('Successfully fetched and cached new DPA list.');
        return dpaList;
    }

    // If fetch fails, return the old (stale) list if it exists, otherwise null
    console.warn('Failed to fetch new DPA list. Will use stale data if available.');
    return result.dpaList || null;
}


// --- Extension Logic ---

/**
 * Analyzes the status of a site from the DPA list and returns a single, simplified status string.
 * The order of precedence is: Denied > Staff Only > Approved > Pending.
 *
 * @param {object|null} siteInfo - The site data object from the DPA list.
 * @returns {string} A simplified status: 'denied', 'staff_only', 'approved', 'pending', or 'unlisted'.
 */
function determineOverallStatus(siteInfo) {
    if (!siteInfo) return 'unlisted';

    const { current_tl_status, current_dpa_status } = siteInfo;

    // 'Rejected' status for the tech lead is a hard 'denied'
    if (current_tl_status === 'Rejected') {
        return 'denied';
    }
    // 'Denied' for DPA status means it's restricted to staff only
    if (current_dpa_status === 'Denied') {
        return 'staff_only';
    }

    // Check for approved conditions
    const isApproved = (current_tl_status === 'Approved' || current_tl_status === 'Not Required');
    const isReceived = (current_dpa_status === 'Received' || current_dpa_status === 'Not Required');

    if (isApproved && isReceived) {
        return 'approved';
    }
    
    // Any other combination is considered 'pending'
    return 'pending';
}

/**
 * Updates the browser action icon and badge for a given tab based on the site's status.
 *
 * @param {string} status - The simplified status key from `determineOverallStatus`.
 * @param {number} tabId - The ID of the tab to update.
 * @param {boolean} isInstalled - If true, a badge is added to indicate an installed app (e.g., from a web store).
 */
function updateIcon(status, tabId, isInstalled) {
    runInExtensionContext(() => {
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

        // Set a visual indicator for installed apps from app stores
        if (isInstalled){
            chrome.action.setBadgeText({ text: '⇲', tabId: tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#ebebeb', tabId: tabId });
        } else {
            chrome.action.setBadgeText({ text: '', tabId: tabId }); // Clear badge otherwise
        }
    }, null);
}

/**
 * The main handler for browser tab updates. It's triggered when a tab's URL changes or it finishes loading.
 * It gets the domain info, checks it against the DPA list, and updates the icon accordingly.
 *
 * @param {number} tabId - The ID of the updated tab.
 * @param {object} changeInfo - An object containing details about the change (e.g., status).
 * @param {object} tab - The full Tab object.
 */
async function handleTabUpdate(tabId, changeInfo, tab) {
    // Only run when the tab is fully loaded and has a valid web URL
    if (changeInfo.status !== 'complete' || !tab.url || !tab.url.startsWith('http')) {
        return;
    }

    const tabDomainInfo = getDomainInfo(tab.url);
    if (!tabDomainInfo) {
        updateIcon('neutral', tabId, false);
        return;
    }

    const dpaList = await getAndUpdateDpaList();
    if (!dpaList) {
        console.log('No DPA list available to check against. Setting icon to neutral.');
        updateIcon('neutral', tabId, tabDomainInfo.isInstalled);
        return;
    }
    
    let siteInfo = null;
    // Match based on App ID if it's an installed app from a store
    if (tabDomainInfo.isInstalled){
        siteInfo = dpaList.find(site => {
            const siteDomainInfo = getDomainInfo(site.resource_link);
            return siteDomainInfo && siteDomainInfo.isInstalled && siteDomainInfo.appID === tabDomainInfo.appID;
        });
    } 
    // Otherwise, match by hostname, but only if it's not a generic app store page
    else if (!tabDomainInfo.isAppStore) { 
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
runInExtensionContext(() => {
    // Main listener for changes in any tab
    chrome.tabs.onUpdated.addListener(handleTabUpdate);

    // Fetch the list on browser startup and extension installation
    chrome.runtime.onStartup.addListener(getAndUpdateDpaList);
    chrome.runtime.onInstalled.addListener(getAndUpdateDpaList);

    // Set up a recurring alarm to refresh the DPA list periodically
    chrome.alarms.create('refreshDpaList', { 
        delayInMinutes: 1, // Wait 1 minute after startup before first run
        periodInMinutes: CACHE_DURATION_MINUTES 
    });

    /**
     * Handles the recurring alarm to refresh the DPA list.
     * @param {chrome.alarms.Alarm} alarm - The alarm that was fired.
     */
    function handleAlarm(alarm) {
        if (alarm.name === 'refreshDpaList') {
            console.log('Periodic alarm triggered. Refreshing DPA list.');
            getAndUpdateDpaList();
        }
    }
    chrome.alarms.onAlarm.addListener(handleAlarm);

    // Listener for messages from the popup UI
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // This handles requests from the popup to get info for the currently viewed page
        if (request.action === "getSiteInfoForUrl") {
            (async () => {
                const domainInfo = getDomainInfo(request.url);
                if (!domainInfo) {
                    sendResponse({ error: 'Invalid URL provided.' });
                    return;
                }

                // Retrieve the list from storage, but don't trigger a fetch
                const { dpaList } = await chrome.storage.local.get('dpaList');
                if (!dpaList) {
                    sendResponse({ error: 'DPA data is not yet available.' });
                    return;
                }

                let siteInfo = null;
                // Find matching site info using the same logic as handleTabUpdate
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

                const overallStatus = determineOverallStatus(siteInfo);

                sendResponse({ siteInfo, domainInfo, overallStatus });
            })();
            
            // Return true to indicate that the response will be sent asynchronously
            return true; 
        }
    });
}, null);