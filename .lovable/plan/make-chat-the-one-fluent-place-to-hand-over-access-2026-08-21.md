# Make chat the one fluent place to hand over access

## Short answer to your question

Partly today, and the gaps are specific.

What already works when you paste details into the chat window:
- WordPress Admin (Application Password or login password), SFTP, SSH (password or private key), FTP/FTPS and a Google service account key are parsed server-side, sealed with encryption, attached to the project, and the raw paste never lands in the conversation — only a masked summary.
- The Access panel updates from server truth, and the agent replies in the thread about what it can now do.
- WordPress and FTP are actually connected to and verified during intake.

What is not true yet:
- **SSH and SFTP are stored but never verified at intake.** They sit as "stored, not verified" until something else triggers a check, so you get no immediate "I'm in".
- **Nothing is written to project Memory.** Access rows are updated; memory entries are not, so the next conversation doesn't "remember" that this site is on WP Engine SSH as user X, port 2222, site root /sites/foo.
- **Unlabelled pastes are missed.** The composer only recognises access text when it finds a `password:`-style label or a PEM key. Bare pastes (three lines of host / user / password, or a hosting panel screenshot-style dump) are treated as ordinary chat and get persisted as plain message text. That is both a fluency gap and a leak risk.
- **Application Passwords with spaces** (`abcd efgh ijkl mnop`) are mis-read by the composer preview, which stops at the first space.
- **Missing fields are mentioned once and then forgotten.** There's no standing "still needed" state the agent chases.
- **Other credential kinds are silently ignored**: hosting control panel, database, Cloudflare/CDN, staging logins. The parser has no section for them, so they're dropped without a word.

## What to build

### 1. Verify SSH and SFTP at intake, like WordPress and FTP
Call the existing SSH/SFTP transport right after sealing, so the chat reply says "connected and verified" or "stored, but the server refused that key/password — here's what it said" instead of a neutral "stored".

### 2. Write access facts into project Memory automatically
On every successful intake, record a non-secret memory entry per access type: which access exists, who the user is, host and port, site root, provider, and verification state. Never the secret. Supersede the prior entry for the same access type so memory stays current instead of accumulating.

### 3. Catch unlabelled and messy pastes before they become chat text
Widen recognition so text that *looks* like access is routed to secure intake, not stored as a message:
- bare `host / user / secret` line triples
- `user@host` plus a following secret
- `sftp://user:pass@host:2222` style URLs
- Application Passwords with spaces
- text following an agent message that asked for access (contextual bias)

When it's a guess rather than a certainty, the composer shows a masked "This looks like site access — send securely?" card with a one-click "It's not access, send as normal text" escape. Nothing ambiguous is silently persisted as plaintext.

### 4. A standing "what I still need" state
Missing fields returned by intake become a small persistent card under the composer (e.g. "SSH: still needs port and site root") that clears itself as each field arrives, and the agent references it in its own voice rather than repeating a list. One card per access type, no nagging.

### 5. Accept the credential kinds people actually have
Add parser sections and storage for: hosting control panel login, database credentials, Cloudflare / CDN API token, staging site login. These are stored and remembered even where Ops can't yet execute against them — with the reply honest about that ("stored; I can't act on Cloudflare yet, but I'll remember it and reference it when advising").

### 6. Fluency in the reply
One calm reply after intake, always answering: what I got, what I proved, what I still need, what I can now do next on your task — and then continuing the task instead of stopping at an access summary.

## Technical notes

- `supabase/functions/credential-intake/index.ts` — add SSH/SFTP verification via `sshTransport`, add memory writes via a service-role insert into `project_memory_entries` with `supersedes` handling, add new access sections.
- `supabase/functions/_shared/credentialText.ts` — new detection rules (bare triples, connection URLs, spaced app passwords, new sections), still deterministic and line-based; PEM handling untouched.
- `src/agent-core/credentialPreview.ts` — mirror the wider detection for the masked composer preview, and add the ambiguous "send securely / send as text" branch.
- `src/ProjectWorkspace.tsx` — persistent missing-fields card, ambiguous-paste choice, unchanged one-shot secure send path.
- Security invariants preserved: raw text leaves the browser exactly once to `credential-intake`, is never persisted in `project_messages`, is never echoed, and memory entries hold only non-secret metadata.
- Verification stays a separate fact from storage everywhere in copy and data.
