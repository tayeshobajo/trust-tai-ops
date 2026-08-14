/**
 * The SSH transport. The only file in the SSH path that opens a socket.
 *
 * Feasibility was established empirically before this existed: `ssh2` runs
 * under Deno through `node:net` and `node:crypto`, provided the cipher list is
 * pinned to CTR modes. Deno's `node:crypto` cannot drive AES-GCM the way
 * `ssh2` needs, so GCM is excluded in `SSH_ALGORITHMS` rather than left to
 * negotiation. A handshake, a host-key fingerprint identical to
 * `ssh-keygen -lf`, public-key auth and a real `exec` with an exit code were
 * all confirmed against a live sshd before any of this was wired up.
 *
 * The interface is separated from the implementation so the safety model can
 * be tested without a network.
 */

import {
  SSH_ALGORITHMS,
  SSH_CONNECT_TIMEOUT_MS,
  WP_CLI_MAX_OUTPUT_BYTES,
} from "./sshSafety.ts";

export type SshTarget = {
  host: string;
  port: number;
  username: string;
  /** Either a private key or a password must be present. */
  privateKey?: string;
  password?: string;
  passphrase?: string;
};

/**
 * The slice of the ssh2 exec stream this file uses. Narrower than the library's
 * own type so the transport can't quietly grow new capabilities.
 */
type SshExecStream = {
  on(event: "data", listener: (chunk: Buffer) => void): SshExecStream;
  on(event: "close", listener: (code: number | null) => void): SshExecStream;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
};

export type SshExecOutcome =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      fingerprint: string;
      durationMs: number;
      outputTruncated: boolean;
    }
  | {
      ok: false;
      kind: "auth_failed" | "unreachable" | "timeout" | "host_key_rejected" | "protocol_error" | "bad_credential";
      fingerprint: string | null;
      detail: string;
    };

export type SshTransport = {
  /**
   * Runs one already-validated command. `acceptHostKey` receives the server's
   * SHA256 fingerprint and decides — the transport never trusts a key itself.
   */
  exec: (
    target: SshTarget,
    command: string,
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SshExecOutcome>;
};

/** Reads at most `limit` characters, then keeps draining without storing. */
const boundedCollector = (limit: number) => {
  let text = "";
  let truncated = false;
  return {
    push(chunk: unknown) {
      if (text.length >= limit) {
        truncated = true;
        return;
      }
      const value = String(chunk);
      const room = limit - text.length;
      if (value.length > room) {
        text += value.slice(0, room);
        truncated = true;
      } else {
        text += value;
      }
    },
    get value() {
      return text;
    },
    get truncated() {
      return truncated;
    },
  };
};


/**
 * A throw out of `client.connect` almost never means the network was down —
 * the usual cause is a private key the parser could not read (line breaks lost
 * on paste, wrong passphrase). Reporting that as "unreachable" sent people
 * looking at their firewall instead of their key, so the two are separated.
 */
const connectFailure = (error: unknown, presented: string | null): SshExecOutcome & { ok: false } => {
  const message = String((error as Error)?.message ?? error ?? "");
  if (/key|passphrase|decrypt|parse|OPENSSH|PEM/i.test(message)) {
    return {
      ok: false,
      kind: "bad_credential",
      fingerprint: presented,
      detail:
        "I could not read that SSH private key. Paste the whole key file, including the BEGIN and END lines, each on its own line - and add the passphrase if the key has one.",
    };
  }
  return {
    ok: false,
    kind: "unreachable",
    fingerprint: presented,
    detail: "I could not open an SSH connection to that server.",
  };
};

export const denoSshTransport = (): SshTransport => ({
  async exec(target, command, timeoutMs, acceptHostKey) {
    const startedAt = Date.now();
    // Imported lazily so the pure safety modules stay runtime-agnostic.
    const { Client } = await import("npm:ssh2@1.16.0");
    const { createHash } = await import("node:crypto");

    const client = new Client();
    let presented: string | null = null;
    let settled = false;

    return await new Promise<SshExecOutcome>((resolve) => {
      const finish = (outcome: SshExecOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try {
          client.end();
        } catch {
          // The connection is already gone; nothing to unwind.
        }
        resolve(outcome);
      };

      const deadline = setTimeout(() => {
        finish({
          ok: false,
          kind: "timeout",
          fingerprint: presented,
          detail: "The server did not finish the inspection in time.",
        });
      }, timeoutMs + SSH_CONNECT_TIMEOUT_MS);

      client.on("ready", () => {
        client.exec(command, (error: Error | undefined, stream: SshExecStream | undefined) => {
          if (error || !stream) {
            finish({
              ok: false,
              kind: "protocol_error",
              fingerprint: presented,
              detail: "The server accepted the connection but refused to run the inspection.",
            });
            return;
          }

          const stdout = boundedCollector(WP_CLI_MAX_OUTPUT_BYTES);
          const stderr = boundedCollector(WP_CLI_MAX_OUTPUT_BYTES);

          stream.on("data", (chunk) => stdout.push(chunk));
          stream.stderr.on("data", (chunk) => stderr.push(chunk));
          stream.on("close", (code: number | null) => {
            finish({
              ok: true,
              exitCode: typeof code === "number" ? code : -1,
              stdout: stdout.value,
              stderr: stderr.value,
              fingerprint: presented ?? "",
              durationMs: Date.now() - startedAt,
              outputTruncated: stdout.truncated || stderr.truncated,
            });
          });
        });
      });

      client.on("error", (error: Error & { level?: string }) => {
        const level = String(error?.level ?? "");
        const message = String(error?.message ?? "");
        if (level.includes("authentication") || /authentication/i.test(message)) {
          finish({
            ok: false,
            kind: "auth_failed",
            fingerprint: presented,
            detail: "The server did not accept that SSH sign-in.",
          });
          return;
        }
        if (/host key|hostkey/i.test(message)) {
          finish({ ok: false, kind: "host_key_rejected", fingerprint: presented, detail: message.slice(0, 200) });
          return;
        }
        finish({
          ok: false,
          kind: /timed out|ETIMEDOUT/i.test(message) ? "timeout" : "unreachable",
          fingerprint: presented,
          detail: "I could not reach that server over SSH.",
        });
      });

      try {
        client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          // Key auth when a key is stored; password auth otherwise. Password
          // auth is what most managed hosts (WP Engine SFTP) actually issue.
          ...(target.privateKey
            ? { privateKey: target.privateKey, passphrase: target.passphrase || undefined }
            : { password: target.password ?? "", tryKeyboard: false }),
          readyTimeout: SSH_CONNECT_TIMEOUT_MS,
          keepaliveInterval: 0,
          algorithms: {
            cipher: [...SSH_ALGORITHMS.cipher],
            hmac: [...SSH_ALGORITHMS.hmac],
            serverHostKey: [...SSH_ALGORITHMS.serverHostKey],
          },
          // Identity is decided by the caller's pinning policy, never here.
          hostVerifier: (key: Uint8Array) => {
            presented = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
            return acceptHostKey(presented);
          },
        });
      } catch (error) {
        finish(connectFailure(error, presented));
      }
    });
  },
});
// ---------------------------------------------------------------------------
// Narrow file-read primitive (SFTP subsystem over the same SSH credential).
// ---------------------------------------------------------------------------

/**
 * Deliberately not a filesystem API. It accepts a list of paths the server has
 * already resolved and validated, stats each one, refuses anything that is not
 * a regular file, and reads only a bounded tail. There is no listing, no
 * globbing, no write mode, and no way for a caller to name a path that did not
 * come out of the closed candidate set.
 */
export type SftpTailRequest = {
  paths: readonly string[];
  maxBytesPerFile: number;
  maxTotalBytes: number;
};

export type SftpTailFile =
  | { path: string; status: "read"; bytesRead: number; size: number; truncated: boolean; text: string }
  | { path: string; status: "missing" | "not_regular" | "unreadable" | "skipped" };

export type SftpTailOutcome =
  | { ok: true; files: SftpTailFile[]; fingerprint: string; durationMs: number }
  | {
      ok: false;
      kind: "auth_failed" | "unreachable" | "timeout" | "host_key_rejected" | "protocol_error" | "sftp_unavailable" | "bad_credential";
      fingerprint: string | null;
      detail: string;
    };

export type SftpTransport = {
  readTails: (
    target: SshTarget,
    request: SftpTailRequest,
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SftpTailOutcome>;
};

type SftpStats = { size: number; isFile: () => boolean };
type SftpSession = {
  stat(path: string, cb: (error: Error | undefined, stats: SftpStats | undefined) => void): void;
  open(path: string, flags: string, cb: (error: Error | undefined, handle: unknown) => void): void;
  read(
    handle: unknown,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
    cb: (error: Error | undefined, bytesRead: number, buffer: Uint8Array) => void,
  ): void;
  close(handle: unknown, cb: (error?: Error) => void): void;
  end(): void;
};

export const denoSftpTransport = (): SftpTransport => ({
  async readTails(target, request, timeoutMs, acceptHostKey) {
    const startedAt = Date.now();
    const { Client } = await import("npm:ssh2@1.16.0");
    const { createHash } = await import("node:crypto");

    const client = new Client();
    let presented: string | null = null;
    let settled = false;

    return await new Promise<SftpTailOutcome>((resolve) => {
      const finish = (outcome: SftpTailOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try {
          client.end();
        } catch {
          // Already gone.
        }
        resolve(outcome);
      };

      const deadline = setTimeout(() => {
        finish({ ok: false, kind: "timeout", fingerprint: presented, detail: "The server did not answer in time." });
      }, timeoutMs + SSH_CONNECT_TIMEOUT_MS);

      client.on("ready", () => {
        client.sftp(async (error: Error | undefined, sftp: SftpSession | undefined) => {
          if (error || !sftp) {
            finish({
              ok: false,
              kind: "sftp_unavailable",
              fingerprint: presented,
              detail: "The server connected but does not offer file reads over SSH.",
            });
            return;
          }

          const files: SftpTailFile[] = [];
          let budget = request.maxTotalBytes;

          const stat = (path: string) =>
            new Promise<SftpStats | null>((done) => sftp.stat(path, (err, stats) => done(err || !stats ? null : stats)));

          try {
            for (const path of request.paths) {
              if (budget <= 0) {
                files.push({ path, status: "skipped" });
                continue;
              }
              const stats = await stat(path);
              if (!stats) {
                files.push({ path, status: "missing" });
                continue;
              }
              if (typeof stats.isFile === "function" && !stats.isFile()) {
                files.push({ path, status: "not_regular" });
                continue;
              }

              const size = Number(stats.size) || 0;
              const want = Math.min(request.maxBytesPerFile, budget, size);
              if (want <= 0) {
                files.push({ path, status: "read", bytesRead: 0, size, truncated: false, text: "" });
                continue;
              }
              const position = Math.max(0, size - want);

              const handle = await new Promise<unknown>((done) =>
                sftp.open(path, "r", (err, value) => done(err ? null : value)),
              );
              if (!handle) {
                files.push({ path, status: "unreadable" });
                continue;
              }

              const buffer = new Uint8Array(want);
              const bytesRead = await new Promise<number>((done) =>
                sftp.read(handle, buffer, 0, want, position, (err, read) => done(err ? -1 : read)),
              );
              await new Promise<void>((done) => sftp.close(handle, () => done()));

              if (bytesRead < 0) {
                files.push({ path, status: "unreadable" });
                continue;
              }
              budget -= bytesRead;
              files.push({
                path,
                status: "read",
                bytesRead,
                size,
                truncated: position > 0,
                text: new TextDecoder().decode(buffer.subarray(0, bytesRead)),
              });
            }
          } finally {
            try {
              sftp.end();
            } catch {
              // The session is already closing.
            }
          }

          finish({ ok: true, files, fingerprint: presented ?? "", durationMs: Date.now() - startedAt });
        });
      });

      client.on("error", (error: Error & { level?: string }) => {
        const level = String(error?.level ?? "");
        const message = String(error?.message ?? "");
        if (level.includes("authentication") || /authentication/i.test(message)) {
          finish({ ok: false, kind: "auth_failed", fingerprint: presented, detail: "The server did not accept that SSH sign-in." });
          return;
        }
        if (/host key|hostkey/i.test(message)) {
          finish({ ok: false, kind: "host_key_rejected", fingerprint: presented, detail: message.slice(0, 200) });
          return;
        }
        finish({
          ok: false,
          kind: /timed out|ETIMEDOUT/i.test(message) ? "timeout" : "unreachable",
          fingerprint: presented,
          detail: "I could not reach that server over SSH.",
        });
      });

      try {
        client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          // Key auth when a key is stored; password auth otherwise. Password
          // auth is what most managed hosts (WP Engine SFTP) actually issue.
          ...(target.privateKey
            ? { privateKey: target.privateKey, passphrase: target.passphrase || undefined }
            : { password: target.password ?? "", tryKeyboard: false }),
          readyTimeout: SSH_CONNECT_TIMEOUT_MS,
          keepaliveInterval: 0,
          algorithms: {
            cipher: [...SSH_ALGORITHMS.cipher],
            hmac: [...SSH_ALGORITHMS.hmac],
            serverHostKey: [...SSH_ALGORITHMS.serverHostKey],
          },
          hostVerifier: (key: Uint8Array) => {
            presented = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
            return acceptHostKey(presented);
          },
        });
      } catch (error) {
        finish(connectFailure(error, presented) as never);
      }
    });
  },
});
