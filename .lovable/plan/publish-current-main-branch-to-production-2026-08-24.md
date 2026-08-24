# Publish current main branch to production

## Goal
Ship the existing finalized build at commit `3b9d13d` on `main` to production without any code changes.

## Steps
1. **Security gate refresh** — Run `security--run_security_scan` because the cached results are stale (last updated 2026-08-23 for Supabase, 2026-08-14 for supply chain). Current results already show zero critical findings, but a fresh scan is required before publishing.
2. **Publish** — If the refreshed scan still has no critical findings, call `preview_ui--publish` on the current finalized project version. No slug or metadata change.
3. **Confirm** — Report the live production URL and deployment status once publishing is scheduled.

## Notes
- No source edits, dependency installs, or edge-function redeploys are included.
- The existing site URL is `https://ops.trusttai.com` (custom domain) and the Lovable-managed URL is `https://ops-trusttai.lovable.app`.
