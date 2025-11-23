# Technical Plan: "SB29-guard-chrome"
This document outlines the technical implementation details, feature set, and rollout strategy for the SB29 Guard Chrome Extension. For a high-level overview of the project's mission and goals, please see the main [README.md](../README.md).

## 🏛️ Architecture: Hybrid Authentication Model
To ensure a secure and seamless experience for our teacher-only user base, we will use a hybrid authentication and authorization model. This approach uses native Chrome APIs for user authentication and a secret API key for application authorization, providing layered security without the need for a custom proxy service.

- **User Authentication:** The extension will use the `chrome.identity.getAuthToken()` API to request an OAuth2 token from Google. This verifies that the user is an authorized teacher logged into their district Google Workspace account, without the extension ever handling passwords.

- **Application Authorization:** The extension will make all requests to the Supabase database using a secure, read-only API key. To protect this key, it is **not** stored in the public repository. Instead, it is injected into the extension's code at build time from a local, git-ignored `config.js` file.

- **URL Whitelisting for Authentication:** The `chrome.identity` flow requires a one-time configuration in Supabase to add the extension's unique redirect URL to the approved list. This ensures that only the official Chrome Extension can initiate the user authentication flow. The URL format is `https://<EXTENSION_ID>.chromiumapp.org`.

### The "Store-First" Workflow
To ensure a stable and predictable Extension ID for whitelisting, we will follow the "Store-First" workflow:
1.  **Reserve the ID:** An initial version of the extension is uploaded to the Chrome Web Store Developer Dashboard to reserve a permanent, fixed ID.
2.  **Whitelist the ID:** This permanent ID is used to construct the redirect URL (`https://<ID>.chromiumapp.org`), which is then added to the Supabase URL Configuration.
3.  **Test & Deploy:** All subsequent release builds (`release.zip`) must be uploaded to the Web Store as a draft or test release. Sideloading the extension will generate a random, temporary ID that will not be recognized by Supabase, causing the user authentication to fail.

## ✅ Feature Set
Our launch-ready version must do the following:

- **Authenticated API Fetch:** The background script must successfully authenticate the user via `chrome.identity` and then fetch data from the Supabase API endpoint using the injected API key.

- **Background URL Monitoring:** The `background.js` script must successfully listen for tab updates and extract the hostname from the current URL.

- **Dynamic Icon:** The extension's icon in the toolbar must change color and shape based on the site's status to support accessibility. We will need to create and include these image assets. Go see the [icon-strategy.yaml](icon-strategy.yaml) for full details: it is the authoratative source. The list below is a summary.

  - **Green Circle:** Approved

  - **Yellow Triangle:** Teaching and Learning approved, not for student accounts

  - **Orange Square:** Status pending, at any level 

  - **Red 'X':** Denied for all use

  - **Purple Diamond:** Unlisted - recommend for review submission

  - **Installed App badge:** Items that can be installed from app stores should be given 

- **Informative Popup:** Clicking the icon opens a `popup.html` that provides a clear summary and a direct link to the official details.

  - **At-a-glance status:** Briefly display the key statuses (e.g., "T&L: Approved", "DPA: Requested").

  - **Plain Language Explanation:** A simple to understand explanation to accompany the objective status messages. 

  - **Primary Call to Action:** A prominent link to "Full Details on MCS App Hub". This will link directly to the specific page for that resource, ensuring teachers always see the most current, official information without us needing to replicate complex UI.

  - **Footnote License Disclaimer:** A de-emphasized text (likely light gray and smaller text) at the bottom of the popup should identify that this extension is covered by an MIT License, and link to the license on GitHub. In a few short words (keeping all of this in a single line of text) it should advocate users know their applicable rules and that this Chrome Extension is a shortcut memory aide, not full legal coverage. 

- **Local Caching & Refresh:** The API data must be stored in `chrome.storage.local` and refreshed periodically (e.g., daily).

- **Domain & App Store Matching Logic:** The extension must intelligently distinguish between standard websites, app store pages, and specific applications within those stores.
  - **Standard Websites:** For most websites, matching will be based on the root domain. The extension will simplify hostnames (e.g., `www.example.com` becomes `example.com`) to provide broad coverage without requiring every subdomain to be listed in the DPA list.
  - **App Stores:** Known app store domains (e.g., `play.google.com`, `apps.apple.com`, etc.) will be handled as special cases. When a user is on a generic app store page (like a homepage or search results), the extension will match against the full, specific subdomain (e.g., `play.google.com`) instead of the root domain. This prevents, for example, the Google Play Store from incorrectly displaying the DPA status for `google.com`.
  - **Applications:** When a user is viewing a specific application page within an app store, the extension will identify the application's unique ID from the URL path or query parameters and use that for matching. This ensures that individual apps have their own distinct DPA status.

## 💻 Tech Stack & Repo Structure
- **Extension Code:** Vanilla JavaScript, HTML, CSS.
- **Build Tooling:** A Node.js script (`build.mjs`) to manage secret injection (API Key, OAuth Client ID) and package the extension.
- **APIs:** Chrome Extension APIs (`Manifest V3`, `chrome.storage`, `chrome.tabs`, `chrome.action`, `chrome.identity`).

- **Repo:** This is a monorepo containing:

- `/extension`: All source code for the extension.

- `/docs`: Public-facing static files, primarily the `index.html` which serves as our Privacy Policy.

## 🏁 Definition of Done
The project is "done" when a teacher can navigate to a website, see the extension icon change correctly, and click it for details that link back to the official App Hub. The extension must pass the Chrome Web Store review for a private extension, with a clear privacy policy hosted on our GitHub Pages site.

---------
## 💡 Future Extensions & Considerations

For future iterations, particularly when adapting this extension for other schools, consider the following enhancements:

- **Google Sheets as Data Source:**
  - **Concept:** Allow schools to use a published Google Sheet as the source of truth for the extension's data. This eliminates the need for a proxy service (Version 2.0) because published Google Sheets are inherently secure and read-only.
  - **Implementation:**
    - Require school administrators to adhere to a predefined column structure in their Google Sheet.
    - Implement an [options page](https://developer.chrome.com/docs/extensions/develop/ui/options-page) where users can input the URL of their school's Google Sheet.
- **Enhanced Information Display:**
  - **Concept:**  Provide more detailed information about each resource than can fit in the popup.
  - **Implementation:**
    - Create dynamically generated summary pages based on the data from the chosen source (Supabase or Google Sheets).
    - Register a [full-page extension](https://developer.chrome.com/docs/extensions/develop/ui/content-scripts) in the manifest to display this detailed information. This is especially useful when using Google Sheets as the data source, as it provides a more readable format than a spreadsheet.
- **Website Blocking (Optional):**
  - **Concept:**  Potentially implement the ability to block websites directly from the Chrome Extension.
  - **Considerations:**
    - This feature requires careful consideration and should be governed by whoever controls the data source (e.g., the administrator managing the Google Sheet).
    -  Ensure that blocking is implemented responsibly and with appropriate user consent and transparency.
- **Unlisted Site Check:**
  - **Concept:** Some sites unlisted by a school district do not need to be recommended for submission/review, if they do not have user accounts or track user data. Scan page contents to determine 'Recommend for review submission.' status, instead of blindly recommending all unlisted sites. 