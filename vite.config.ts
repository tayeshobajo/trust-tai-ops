import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// These are public, browser-safe values committed in .env.production.
// Explicitly defining them here ensures the production Supabase project is
// always baked into the bundle, even when the hosting platform injects its own
// VITE_SUPABASE_* values at build time.
const OPS_SUPABASE_URL = "https://tdqeizrgdasztvbvwanp.supabase.co";
const OPS_SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkcWVpenJnZGFzenR2YnZ3YW5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzExOTMsImV4cCI6MjEwMTk0NzE5M30.nygr3L3Dq6Bh3ZjOF5wKnlNvUXPSEwNmMtbMV9pOORA";

export default defineConfig({
  plugins: [react()],
  define: {
    // Always win over platform-injected VITE_SUPABASE_* values.
    "import.meta.env.VITE_OPS_SUPABASE_URL": JSON.stringify(OPS_SUPABASE_URL),
    "import.meta.env.VITE_OPS_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(OPS_SUPABASE_KEY),
  },
});
