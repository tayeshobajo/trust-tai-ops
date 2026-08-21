/**
 * The SSH transport. The only file in the SSH path that opens a socket.
 *
 * Feasibility was established empirically before this existed: `ssh2` runs
 * under Deno through `node:net` and `node:crypto`, with the cipher list pinned
 * to the runtime-compatible OpenSSH AES-GCM modes. A handshake, a host-key
 * fingerprint identical to
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
  if (/key|passphrase|decrypt|decode|parse|base64|malformed|unsupported|OPENSSH|PEM/i.test(message)) {
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

type SshClientError = Error & { level?: string; code?: string };

/**
 * ssh2 reports most failures through the async `error` event, not as a throw
 * from `connect()`. Classify those with the library's level/code first so a
 * handshake, key, or authentication failure is never described as a dead
 * server. The diagnostic log contains no host, username, or credential.
 */
const clientFailure = (error: SshClientError, presented: string | null): SshExecOutcome & { ok: false } => {
  const level = String(error?.level ?? "");
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  console.warn("ssh_connection_failed", {
    level: level.slice(0, 80),
    code: code.slice(0, 80),
    message: message.slice(0, 240),
    hostKeyPresented: Boolean(presented),
  });

  if (/key|passphrase|decrypt|decode|parse|base64|malformed|unsupported|OPENSSH|PEM/i.test(message)) {
    return connectFailure(error, presented);
  }
  if (/unknown cipher/i.test(message)) {
    return {
      ok: false,
      kind: "protocol_error",
      fingerprint: presented,
      detail: "The secure SSH connection could not start because this server and the connection runtime could not agree on encryption.",
    };
  }
  if (level.includes("authentication") || /authentication|all configured authentication methods failed/i.test(message)) {
    return {
      ok: false,
      kind: "auth_failed",
      fingerprint: presented,
      detail:
        "The SSH server answered, but it did not accept this key for that username. Confirm the matching public key is assigned to this exact WP Engine environment, then replace the stored private key if needed.",
    };
  }
  if (/host key|hostkey/i.test(message)) {
    return { ok: false, kind: "host_key_rejected", fingerprint: presented, detail: message.slice(0, 200) };
  }
  if (/timed out|ETIMEDOUT/i.test(`${code} ${message}`)) {
    return { ok: false, kind: "timeout", fingerprint: presented, detail: "The SSH server did not answer in time." };
  }
  if (
    level.includes("handshake") ||
    /handshake|no matching|protocol|identification string|before handshake/i.test(message)
  ) {
    return {
      ok: false,
      kind: "protocol_error",
      fingerprint: presented,
      detail: "The SSH server answered, but the secure handshake could not be completed.",
    };
  }
  if (/ECONNREFUSED/i.test(`${code} ${message}`)) {
    return { ok: false, kind: "unreachable", fingerprint: presented, detail: "The SSH server refused the connection on that port." };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${code} ${message}`)) {
    return { ok: false, kind: "unreachable", fingerprint: presented, detail: "The SSH server address could not be resolved." };
  }
  if (/ECONNRESET|socket closed|connection lost/i.test(`${code} ${message}`)) {
    return {
      ok: false,
      kind: "protocol_error",
      fingerprint: presented,
      detail: "The SSH gateway closed the connection before sign-in completed. The server is reachable, but the SSH session was not accepted.",
    };
  }
  return {
    ok: false,
    kind: "protocol_error",
    fingerprint: presented,
    detail: "The SSH server answered, but the connection could not be completed.",
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

      client.on("error", (error: SshClientError) => finish(clientFailure(error, presented)));

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

// ---------------------------------------------------------------------------
// SFTP write types
// ---------------------------------------------------------------------------

export type SftpWriteRequest = {
  /** Absolute path on the remote server. Validated by caller — no '..' allowed. */
  path: string;
  /** UTF-8 content to write. Max 512 KB enforced here. */
  content: string;
  /** If true, read existing content before overwriting and return it in backupContent. */
  backupFirst?: boolean;
};

export type SftpWriteOutcome =
  | {
      ok: true;
      bytesWritten: number;
      backupContent?: string;
      fingerprint: string;
      durationMs: number;
    }
  | {
      ok: false;
      kind:
        | "auth_failed"
        | "unreachable"
        | "timeout"
        | "host_key_rejected"
        | "protocol_error"
        | "sftp_unavailable"
        | "bad_credential"
        | "path_unsafe"
        | "write_failed";
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
  writeFile: (
    target: SshTarget,
    request: SftpWriteRequest,
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SftpWriteOutcome>;
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

// Extended SFTP session type — adds write primitive.
type SftpWriteSession = {
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
  write(
    handle: unknown,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
    cb: (error?: Error) => void,
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

      client.on("error", (error: SshClientError) => finish(clientFailure(error, presented) as SftpTailOutcome));

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

  async writeFile(target, request, timeoutMs, acceptHostKey) {
    const MAX_WRITE_BYTES = 512 * 1024;

    // Path safety: absolute, no '..', no null bytes.
    if (!request.path.startsWith("/") || request.path.includes("..") || request.path.includes("\x00")) {
      return { ok: false, kind: "path_unsafe" as const, fingerprint: null, detail: "The file path must be absolute and must not contain '..' or null bytes." };
    }

    const encoded = new TextEncoder().encode(request.content);
    if (encoded.byteLength > MAX_WRITE_BYTES) {
      return { ok: false, kind: "write_failed" as const, fingerprint: null, detail: `File content exceeds the 512 KB write limit (${encoded.byteLength} bytes).` };
    }

    const startedAt = Date.now();
    const { Client } = await import("npm:ssh2@1.16.0");
    const { createHash } = await import("node:crypto");
    const client = new Client();
    let presented: string | null = null;
    let settled = false;

    return await new Promise<SftpWriteOutcome>((resolve) => {
      const finish = (outcome: SftpWriteOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try { client.end(); } catch { /* already gone */ }
        resolve(outcome);
      };
      const deadline = setTimeout(() => {
        finish({ ok: false, kind: "timeout", fingerprint: presented, detail: "The write timed out." });
      }, timeoutMs + SSH_CONNECT_TIMEOUT_MS);

      client.on("ready", () => {
        client.sftp(async (error: Error | undefined, sftp: SftpWriteSession | undefined) => {
          if (error || !sftp) {
            finish({ ok: false, kind: "sftp_unavailable", fingerprint: presented, detail: "The server connected but does not offer file writes over SSH." });
            return;
          }
          try {
            let backupContent: string | undefined;
            if (request.backupFirst) {
              const stats = await new Promise<SftpStats | null>((done) =>
                sftp.stat(request.path, (err, s) => done(err || !s ? null : s)),
              );
              if (stats && typeof (stats as SftpStats).isFile === "function" && (stats as SftpStats).isFile()) {
                const size = Math.min(Number(stats.size) || 0, MAX_WRITE_BYTES);
                if (size > 0) {
                  const rh = await new Promise<unknown>((done) => sftp.open(request.path, "r", (e, h) => done(e ? null : h)));
                  if (rh) {
                    const buf = new Uint8Array(size);
                    const n = await new Promise<number>((done) => sftp.read(rh, buf, 0, size, 0, (e, nr) => done(e ? -1 : nr)));
                    await new Promise<void>((done) => sftp.close(rh, () => done()));
                    if (n > 0) backupContent = new TextDecoder().decode(buf.subarray(0, n));
                  }
                }
              }
            }
            const wh = await new Promise<unknown>((done) => sftp.open(request.path, "w", (e, h) => done(e ? null : h)));
            if (!wh) {
              sftp.end();
              finish({ ok: false, kind: "write_failed", fingerprint: presented, detail: "Could not open the remote file for writing." });
              return;
            }
            const written = await new Promise<number>((done) =>
              sftp.write(wh, encoded, 0, encoded.byteLength, 0, (e) => done(e ? -1 : encoded.byteLength)),
            );
            await new Promise<void>((done) => sftp.close(wh, () => done()));
            sftp.end();
            if (written < 0) {
              finish({ ok: false, kind: "write_failed", fingerprint: presented, detail: "The write to the remote file failed." });
              return;
            }
            finish({ ok: true, bytesWritten: written, backupContent, fingerprint: presented ?? "", durationMs: Date.now() - startedAt });
          } catch (err) {
            sftp.end();
            finish({ ok: false, kind: "write_failed", fingerprint: presented, detail: `Write threw: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
          }
        });
      });

      client.on("error", (error: SshClientError) => finish(clientFailure(error, presented) as SftpWriteOutcome));
      try {
        client.connect({
          host: target.host, port: target.port, username: target.username,
          ...(target.privateKey ? { privateKey: target.privateKey, passphrase: target.passphrase || undefined } : { password: target.password ?? "", tryKeyboard: false }),
          readyTimeout: SSH_CONNECT_TIMEOUT_MS, keepaliveInterval: 0,
          algorithms: { cipher: [...SSH_ALGORITHMS.cipher], hmac: [...SSH_ALGORITHMS.hmac], serverHostKey: [...SSH_ALGORITHMS.serverHostKey] },
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

// ---------------------------------------------------------------------------
// General file operations over the SFTP subsystem.
// ---------------------------------------------------------------------------

/**
 * Unlike `readTails`, these accept a caller-named path. That is safe only
 * because every caller routes through `fileAccess.ts`, which confines paths to
 * the project's own site root before anything reaches a socket.
 */
export type SftpEntry = {
  name: string;
  kind: "file" | "dir" | "link" | "other";
  size: number | null;
  modifiedAt: string | null;
};

export type SftpOpsFailure = {
  ok: false;
  kind:
    | "auth_failed"
    | "unreachable"
    | "timeout"
    | "host_key_rejected"
    | "protocol_error"
    | "sftp_unavailable"
    | "bad_credential"
    | "not_found"
    | "write_failed";
  fingerprint: string | null;
  detail: string;
};

export type SftpListOutcome = { ok: true; entries: SftpEntry[]; truncated: boolean; fingerprint: string } | SftpOpsFailure;

export type SftpReadOutcome =
  | { ok: true; size: number; bytesRead: number; truncated: boolean; text: string; modifiedAt: string | null; fingerprint: string }
  | SftpOpsFailure;

export type SftpRenameOutcome = { ok: true; fingerprint: string } | SftpOpsFailure;

export type SftpFileOps = {
  list: (
    target: SshTarget,
    path: string,
    maxEntries: number,
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SftpListOutcome>;
  read: (
    target: SshTarget,
    path: string,
    request: { maxBytes: number; from: "tail" | "start" },
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SftpReadOutcome>;
  rename: (
    target: SshTarget,
    from: string,
    to: string,
    timeoutMs: number,
    acceptHostKey: (fingerprint: string) => boolean,
  ) => Promise<SftpRenameOutcome>;
};

type SftpDirEntry = {
  filename: string;
  longname?: string;
  attrs: { size?: number; mtime?: number; isDirectory?: () => boolean; isFile?: () => boolean; isSymbolicLink?: () => boolean };
};

type SftpOpsSession = SftpWriteSession & {
  readdir(path: string, cb: (error: Error | undefined, list: SftpDirEntry[] | undefined) => void): void;
  rename(from: string, to: string, cb: (error?: Error) => void): void;
  lstat(path: string, cb: (error: Error | undefined, stats: SftpStats | undefined) => void): void;
};

/** Opens one authenticated SFTP session and hands it to `run`. */
const withSftpSession = async <T>(
  target: SshTarget,
  timeoutMs: number,
  acceptHostKey: (fingerprint: string) => boolean,
  run: (sftp: SftpOpsSession, fingerprint: string) => Promise<T>,
): Promise<T | SftpOpsFailure> => {
  const { Client } = await import("npm:ssh2@1.16.0");
  const { createHash } = await import("node:crypto");
  const client = new Client();
  let presented: string | null = null;
  let settled = false;

  return await new Promise<T | SftpOpsFailure>((resolve) => {
    const finish = (outcome: T | SftpOpsFailure) => {
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
      client.sftp(async (error: Error | undefined, sftp: SftpOpsSession | undefined) => {
        if (error || !sftp) {
          finish({
            ok: false,
            kind: "sftp_unavailable",
            fingerprint: presented,
            detail: "The server connected but does not offer file access over SSH.",
          });
          return;
        }
        try {
          finish(await run(sftp, presented ?? ""));
        } catch (err) {
          finish({
            ok: false,
            kind: "protocol_error",
            fingerprint: presented,
            detail: String((err as Error)?.message ?? err).slice(0, 200),
          });
        } finally {
          try {
            sftp.end();
          } catch {
            // Closing anyway.
          }
        }
      });
    });

    client.on("error", (error: SshClientError) => finish(clientFailure(error, presented) as SftpOpsFailure));

    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
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
      finish(connectFailure(error, presented) as SftpOpsFailure);
    }
  });
};

export const denoSftpFileOps = (): SftpFileOps => ({
  async list(target, path, maxEntries, timeoutMs, acceptHostKey) {
    return await withSftpSession<SftpListOutcome>(target, timeoutMs, acceptHostKey, async (sftp, fingerprint) => {
      const list = await new Promise<SftpDirEntry[] | null>((done) =>
        sftp.readdir(path, (err, value) => done(err || !value ? null : value)),
      );
      if (!list) {
        return { ok: false, kind: "not_found", fingerprint, detail: "That folder could not be listed on the server." };
      }
      const entries: SftpEntry[] = list
        .filter((item) => item.filename !== "." && item.filename !== "..")
        .map((item) => ({
          name: item.filename,
          kind: item.attrs?.isDirectory?.()
            ? ("dir" as const)
            : item.attrs?.isSymbolicLink?.()
              ? ("link" as const)
              : item.attrs?.isFile?.()
                ? ("file" as const)
                : ("other" as const),
          size: typeof item.attrs?.size === "number" ? item.attrs.size : null,
          modifiedAt: typeof item.attrs?.mtime === "number" ? new Date(item.attrs.mtime * 1000).toISOString() : null,
        }));
      return { ok: true, entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries, fingerprint };
    });
  },

  async read(target, path, request, timeoutMs, acceptHostKey) {
    return await withSftpSession<SftpReadOutcome>(target, timeoutMs, acceptHostKey, async (sftp, fingerprint) => {
      const stats = await new Promise<SftpStats | null>((done) =>
        sftp.stat(path, (err, value) => done(err || !value ? null : value)),
      );
      if (!stats) return { ok: false, kind: "not_found", fingerprint, detail: "That file is not there." };
      if (typeof stats.isFile === "function" && !stats.isFile()) {
        return { ok: false, kind: "not_found", fingerprint, detail: "That path is not a regular file." };
      }
      const size = Number(stats.size) || 0;
      const want = Math.min(request.maxBytes, size);
      if (want <= 0) {
        return { ok: true, size, bytesRead: 0, truncated: false, text: "", modifiedAt: null, fingerprint };
      }
      const position = request.from === "tail" ? Math.max(0, size - want) : 0;
      const handle = await new Promise<unknown>((done) => sftp.open(path, "r", (err, value) => done(err ? null : value)));
      if (!handle) return { ok: false, kind: "not_found", fingerprint, detail: "That file could not be opened." };
      const buffer = new Uint8Array(want);
      const bytesRead = await new Promise<number>((done) =>
        sftp.read(handle, buffer, 0, want, position, (err, read) => done(err ? -1 : read)),
      );
      await new Promise<void>((done) => sftp.close(handle, () => done()));
      if (bytesRead < 0) return { ok: false, kind: "not_found", fingerprint, detail: "That file could not be read." };
      return {
        ok: true,
        size,
        bytesRead,
        truncated: position > 0 || want < size,
        text: new TextDecoder().decode(buffer.subarray(0, bytesRead)),
        modifiedAt: null,
        fingerprint,
      };
    });
  },

  async rename(target, from, to, timeoutMs, acceptHostKey) {
    return await withSftpSession<SftpRenameOutcome>(target, timeoutMs, acceptHostKey, async (sftp, fingerprint) => {
      const failure = await new Promise<Error | undefined>((done) => sftp.rename(from, to, (err) => done(err)));
      if (failure) {
        return { ok: false, kind: "write_failed", fingerprint, detail: "The server refused the rename." };
      }
      return { ok: true, fingerprint };
    });
  },
});
