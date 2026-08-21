# Why Ops stalled where your other agent didn't — and the fix

Same brief, same credentials, two very different outcomes. The other agent logged in over FTPS, listed the site root, read `error_log`, found the WP Rocket fatal, and looked at the code. Ops asked for a WordPress Application Password on a site that returns HTTP 500 — a login page that can't render — and then said it "saw credential-shaped text but couldn't store it securely yet."

That isn't a personality problem. Three concrete capabilities are missing.

## What's actually missing

**1. Ops has no FTP/FTPS transport.**
The credential reader parses your paste correctly — it recognises FTP host, user, password, port 21. Then intake deliberately rejects it: this deployment can store SSH and SFTP, and refuses plain FTP/FTPS. So the one access you had was thrown away, and the agent fell back to asking for wp-admin.

**2. Even over SFTP, Ops can't explore a filesystem.**
The only file capability that exists is a fixed-path error-log tail: a closed candidate list, no directory listing, no arbitrary file read, no rename or move. `filesystem.read` and `filesystem.write` are declared in the catalog but return "not available". The other agent's whole method — list the root, find `error_log`, check its size and mtime, tail it, open `Cloudflare.php` around line 496 — is not expressible in Ops today.

**3. The planner can't see the write tools the server already has.**
The edge function implements `wordpress.rest_api_write`, `wordpress.sftp_write_file`, `wordpress.run_wp_cli_write`, cache purge and snippet tools. The client tool catalog the reasoner plans from doesn't list them, so they are effectively unreachable.

On top of that, access triage is wrong for an outage: when the public site returns 5xx, wp-admin is the least likely route in and should not be the first ask.

## What gets built

**FTP / FTPS access, first-class**
- Credential intake accepts and seals FTP and FTPS (explicit AUTH TLS) alongside SSH/SFTP, with the port defaulting sensibly and a verification connect that confirms login and reports back in chat.
- A real FTP client in the execution gateway: control channel, explicit TLS upgrade, passive data transfers, tolerant of the self-signed certificates shared hosts serve.
- Access panel and chat both show FTP/FTPS as a supported, verified access type.

**File tools the agent can actually investigate with**
- List a directory (bounded entries, with size and modified time).
- Read a file — bounded tail or byte range, with a size ceiling, and secret redaction on the way out.
- Rename / move a path, and write a file, both change-class.
- Each works over whichever of FTP, FTPS, SFTP or SSH the project has, chosen by the server. Paths stay confined to the site root recorded for the project; nothing outside it can be opened.

**Recovery you approve in chat**
- The agent proposes the exact change in plain English ("rename `wp-content/plugins/wp-rocket` to `wp-rocket.disabled`"), you approve inline, and only then does it act.
- Before any write it captures the prior state as evidence so the change is reversible, then re-checks the public response and reports whether the site came back.

**Better triage**
- A 5xx site routes straight to file access (FTP/FTPS/SFTP/SSH) as the primary ask; wp-admin is only requested when the site is actually serving.
- The write tools already implemented server-side become visible to the planner, so fix plans reference real capabilities instead of dead ends.

## Technical notes

- `supabase/functions/_shared/ftpTransport.ts` — new: FTP/FTPS over `Deno.connect` + `Deno.startTls`, passive mode, with `list`, `read`, `write`, `rename`, `stat`; relaxed cert verification for self-signed hosts, timeouts and byte ceilings throughout.
- `supabase/functions/_shared/credentialText.ts` / `credential-intake/index.ts` — remove the FTP rejection branch; store `ftp` / `ftps` providers, verify by connecting, audit as with SSH.
- `supabase/functions/_shared/fileAccess.ts` — new: one path-confined file layer that picks FTP/FTPS/SFTP/SSH per project and enforces root confinement, size limits and redaction.
- `supabase/functions/agent-execute/index.ts` — dispatch `filesystem.list`, `filesystem.read`, `filesystem.rename`, `filesystem.write` through that layer; extend `EXECUTABLE_ACCESS_TYPES` with `ftp`.
- `src/agent-core/types.ts`, `registry.ts`, `policy.ts`, `verify.ts` — add the file tools and the already-implemented write tools; classify rename/write as change-class requiring approval.
- `supabase/functions/_shared/reasonCatalog.ts` / `reasonPrompt.ts` — add investigate steps (list root, stat and tail logs, read a named file) and a fix step for rename/disable.
- `src/agent-core/orchestrator.ts`, `src/hostGuidance.ts`, `src/reply.ts` — access-priority change for 5xx outages.
- DB: extend the access-type enum/check to include `ftp`; no other schema change. Credential handling stays sealed server-side, nothing new reaches the browser.
