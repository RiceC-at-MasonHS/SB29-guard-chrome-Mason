// This is an example configuration file.
// To build the extension, create a 'config.mjs' file in the root of this project.
// You will need to provide the OAuth2 Client ID from your Google Cloud project and your Supabase URL and public API (anon) key.

export default {
  // The Client ID for OAuth2, obtained from Google Cloud Console.
  OAUTH2_CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
  
  // The public-facing 'anon' key for your Supabase project.
  API_KEY: "YOUR_SUPABASE_ANON_KEY",

  // The public-facing URL for your Supabase project data.
  API_URI: "https://<YOUR_PROJECT_ID>.supabase.co/some/path/needed",

  // The hostname of your Supabase project, used for host permissions in the manifest.
  API_HOST: "https://<YOUR_PROJECT_ID>.supabase.co"
};