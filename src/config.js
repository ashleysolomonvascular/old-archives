// Google OAuth client ID (public by design - it is not a secret). Created in Google Cloud Console as a
// "Web application" client with the GitHub Pages origin and redirect URI authorised. Empty = Drive backup off.
const BAKED_IN = ''; // <- paste the client ID here
export const GOOGLE_CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID || BAKED_IN; // env override is for local testing
