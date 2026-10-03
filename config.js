export const SUPABASE_URL = "https://ubyfjnwplxavuirzejad.supabase.co";
export const SUPABASE_KEY = "sb_publishable_GFMyPY3JZCJ7vOnCp-8a0g_gIN2rpvq";

// remember the link hash (password-reset / email links) before the Supabase client clears it
window.__initialHash = location.hash;

// additional stylesheet for the v3 interface (loaded here so index.html stays untouched)
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "./extra.css";
document.head.appendChild(link);
