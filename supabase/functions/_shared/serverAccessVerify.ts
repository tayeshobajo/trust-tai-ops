/**
 * Live verification for SSH and SFTP access, at the moment it is shared.
 *
 * Storing a credential and proving it works are two different facts, and this
 * module only ever produces the second one. It connects once, records the
 * server's identity on that first connection, and returns a plain-language
 * outcome. It never returns, logs or echoes secret material.
 */

import { denoSftpFileOps, denoSshTransport, type SshTarget } from "./sshTransport.ts";

export type ServerVerifyState = "verified" | "rejected" | "needs_attention";

export type ServerVerifyOutcome = {
  state: ServerVerifyState;
  /** Safe to show a person. Never contains a credential. */
  note: string;
  /** SHA256 identity observed on the connection, when one was completed. */
  fingerprint: string | null;
};

const TIMEOUT_MS = 20_000;

const rejected = (detail: string): ServerVerifyOutcome => ({
  state: "rejected",
  note: `The server answered but did not accept that sign-in. ${detail}`.trim(),
  fingerprint: null,
});

/**
 * Tries SSH first for shell accounts, then falls back to an SFTP directory
 * listing — jailed SFTP-only accounts refuse `exec` but answer SFTP fine.
 */
export const verifyServerAccess = async (
  accessType: "ssh" | "sftp",
  target: SshTarget,
): Promise<ServerVerifyOutcome> => {
  let observed: string | null = null;
  const acceptFirstUse = (fingerprint: string) => {
    // The person just handed this credential over deliberately, so a first
    // identity is recorded rather than trusted silently forever.
    observed = fingerprint;
    return true;
  };

  if (accessType === "ssh") {
    const outcome = await denoSshTransport().exec(target, "true", TIMEOUT_MS, acceptFirstUse);
    if (outcome.ok) {
      return {
        state: "verified",
        note: "Signed in over SSH and it works. I can read the server and run read-only checks now.",
        fingerprint: outcome.fingerprint ?? observed,
      };
    }
    if (outcome.kind === "auth_failed" || outcome.kind === "bad_credential") {
      return rejected("Please double-check the username and key or password.");
    }
    // Shell may be disabled while SFTP still works — that is worth knowing.
    const viaSftp = await verifySftp(target, acceptFirstUse, () => observed);
    if (viaSftp.state === "verified") {
      return {
        ...viaSftp,
        note: "The server refused a shell session but accepted SFTP, so I can read and change files but not run commands.",
      };
    }
    return {
      state: "needs_attention",
      note: `Stored securely, but I could not connect just now: ${outcome.detail}`,
      fingerprint: null,
    };
  }

  return await verifySftp(target, acceptFirstUse, () => observed);
};

const verifySftp = async (
  target: SshTarget,
  acceptFirstUse: (fingerprint: string) => boolean,
  observed: () => string | null,
): Promise<ServerVerifyOutcome> => {
  const listing = await denoSftpFileOps().list(target, ".", 5, TIMEOUT_MS, acceptFirstUse);
  if (listing.ok) {
    return {
      state: "verified",
      note: "Signed in over SFTP and it works. I can read and change files on that server now.",
      fingerprint: listing.fingerprint ?? observed(),
    };
  }
  if (listing.kind === "auth_failed" || listing.kind === "bad_credential") {
    return rejected("Please double-check the username and key or password.");
  }
  return {
    state: "needs_attention",
    note: `Stored securely, but I could not connect just now: ${listing.detail}`,
    fingerprint: null,
  };
};
