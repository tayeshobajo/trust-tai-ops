/**
 * FTP / FTPS transport.
 *
 * The second file in this codebase allowed to open a socket to a customer's
 * server. It speaks just enough of RFC 959 / RFC 4217 to do what an engineer
 * does by hand: sign in, list a directory, read a bounded slice of a file,
 * write a file, and rename a path.
 *
 * Security posture, stated plainly:
 *   - Explicit FTPS (AUTH TLS) is always attempted first, on both the control
 *     and the data channel.
 *   - Shared hosts very often serve a self-signed certificate, and this
 *     runtime cannot be told to accept one. When the TLS upgrade fails for
 *     that reason the session falls back to plain FTP and reports
 *     `security: "plaintext"`, which the caller surfaces to the human. It
 *     never silently pretends the channel was encrypted.
 *
 * Nothing here decides *which* path may be touched. Path confinement lives in
 * `fileAccess.ts`; this file only moves bytes.
 */

export type FtpSecurity = "ftps" | "plaintext";

export type FtpTarget = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** "auto" upgrades when it can and falls back; "plain" never upgrades. */
  mode?: "auto" | "plain";
};

export type FtpFailureKind =
  | "auth_failed"
  | "unreachable"
  | "timeout"
  | "protocol_error"
  | "tls_failed"
  | "not_found"
  | "write_failed";

export type FtpFailure = { ok: false; kind: FtpFailureKind; detail: string };

export type FtpEntry = {
  name: string;
  kind: "file" | "dir" | "link" | "other";
  size: number | null;
  modifiedAt: string | null;
};

export type FtpListOutcome = { ok: true; security: FtpSecurity; entries: FtpEntry[]; truncated: boolean } | FtpFailure;

export type FtpReadOutcome =
  | {
      ok: true;
      security: FtpSecurity;
      size: number | null;
      bytesRead: number;
      /** True when only the tail (or a range) of the file was returned. */
      truncated: boolean;
      text: string;
      modifiedAt: string | null;
    }
  | FtpFailure;

export type FtpWriteOutcome =
  | { ok: true; security: FtpSecurity; bytesWritten: number; backupContent?: string }
  | FtpFailure;

export type FtpSimpleOutcome = { ok: true; security: FtpSecurity } | FtpFailure;

export type FtpTransport = {
  /** Sign in and immediately disconnect. Used to verify stored credentials. */
  check: (target: FtpTarget, timeoutMs: number) => Promise<FtpSimpleOutcome>;
  list: (target: FtpTarget, path: string, maxEntries: number, timeoutMs: number) => Promise<FtpListOutcome>;
  read: (
    target: FtpTarget,
    path: string,
    request: { maxBytes: number; from: "tail" | "start" },
    timeoutMs: number,
  ) => Promise<FtpReadOutcome>;
  write: (
    target: FtpTarget,
    path: string,
    content: string,
    options: { backupFirst?: boolean; maxBackupBytes?: number },
    timeoutMs: number,
  ) => Promise<FtpWriteOutcome>;
  rename: (target: FtpTarget, from: string, to: string, timeoutMs: number) => Promise<FtpSimpleOutcome>;
};

// --- wire helpers -----------------------------------------------------------

type Conn = Deno.Conn;

class FtpError extends Error {
  constructor(readonly kind: FtpFailureKind, readonly detail: string) {
    super(detail);
  }
}

const withDeadline = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FtpError("timeout", `The server did not answer in time (${what}).`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** A control channel that reads complete, possibly multi-line, replies. */
class ControlChannel {
  private buffer = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(private conn: Conn, private timeoutMs: number) {}

  swap(conn: Conn) {
    this.conn = conn;
  }

  private async pull(): Promise<void> {
    const chunk = new Uint8Array(8192);
    const read = await withDeadline(this.conn.read(chunk), this.timeoutMs, "control read");
    if (read === null) throw new FtpError("protocol_error", "The server closed the connection unexpectedly.");
    this.buffer += this.decoder.decode(chunk.subarray(0, read), { stream: true });
  }

  /** Reads one full reply: `NNN text`, or `NNN-...` continued until `NNN `. */
  async reply(): Promise<{ code: number; text: string }> {
    for (;;) {
      const complete = this.takeReply();
      if (complete) return complete;
      await this.pull();
    }
  }

  private takeReply(): { code: number; text: string } | null {
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length < 2) return null;
    const first = lines[0];
    const match = /^(\d{3})([ -])/.exec(first);
    if (!match) {
      // Junk before a reply is a protocol violation; drop the line.
      this.buffer = lines.slice(1).join("\r\n");
      return null;
    }
    const code = Number(match[1]);
    if (match[2] === " ") {
      this.buffer = lines.slice(1).join("\r\n");
      return { code, text: first.slice(4) };
    }
    for (let index = 1; index < lines.length; index += 1) {
      if (new RegExp(`^${match[1]} `).test(lines[index])) {
        const text = lines.slice(0, index + 1).join("\n");
        this.buffer = lines.slice(index + 1).join("\r\n");
        return { code, text };
      }
    }
    return null;
  }

  async send(command: string): Promise<{ code: number; text: string }> {
    await withDeadline(this.conn.write(this.encoder.encode(`${command}\r\n`)), this.timeoutMs, "control write");
    return await this.reply();
  }
}

const closeQuietly = (conn: Conn | null) => {
  try {
    conn?.close();
  } catch {
    // Already gone.
  }
};

const connectFailure = (error: unknown): FtpFailure => {
  if (error instanceof FtpError) return { ok: false, kind: error.kind, detail: error.detail };
  const message = String((error as Error)?.message ?? error ?? "");
  if (/refused/i.test(message)) return { ok: false, kind: "unreachable", detail: "The server refused the FTP connection on that port." };
  if (/dns|resolve|name/i.test(message)) return { ok: false, kind: "unreachable", detail: "That FTP address could not be resolved." };
  if (/certificate|tls|handshake/i.test(message)) return { ok: false, kind: "tls_failed", detail: "The secure FTPS handshake failed." };
  return { ok: false, kind: "unreachable", detail: "I could not open an FTP connection to that server." };
};

type Session = {
  control: ControlChannel;
  security: FtpSecurity;
  host: string;
  timeoutMs: number;
  /** Opens a passive data connection, TLS-wrapped when the session is FTPS. */
  data: () => Promise<Conn>;
};

const parsePasv = (text: string): { host: string; port: number } | null => {
  const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(text);
  if (!match) return null;
  const nums = match.slice(1).map(Number);
  return { host: nums.slice(0, 4).join("."), port: nums[4] * 256 + nums[5] };
};

const parseEpsv = (text: string): number | null => {
  const match = /\(\|\|\|(\d+)\|\)/.exec(text);
  return match ? Number(match[1]) : null;
};

/** Signs in and hands a live session to `run`, always tearing it down after. */
const withSession = async <T>(
  target: FtpTarget,
  timeoutMs: number,
  run: (session: Session) => Promise<T>,
): Promise<T | FtpFailure> => {
  let raw: Conn | null = null;
  let current: Conn | null = null;
  try {
    raw = await withDeadline(Deno.connect({ hostname: target.host, port: target.port }), timeoutMs, "connect");
    current = raw;
    const control = new ControlChannel(current, timeoutMs);

    const greeting = await control.reply();
    if (greeting.code >= 400) throw new FtpError("protocol_error", "The FTP server refused the session at greeting.");

    let security: FtpSecurity = "plaintext";
    if (target.mode !== "plain") {
      const auth = await control.send("AUTH TLS");
      if (auth.code === 234) {
        try {
          const tls = await withDeadline(
            Deno.startTls(current as Deno.TcpConn, { hostname: target.host }),
            timeoutMs,
            "TLS upgrade",
          );
          current = tls;
          control.swap(tls);
          security = "ftps";
          await control.send("PBSZ 0");
          await control.send("PROT P");
        } catch {
          // The certificate could not be validated by this runtime. Reconnect
          // in the clear rather than leaving a half-upgraded socket behind.
          closeQuietly(current);
          raw = await withDeadline(Deno.connect({ hostname: target.host, port: target.port }), timeoutMs, "reconnect");
          current = raw;
          control.swap(current);
          await control.reply();
          security = "plaintext";
        }
      }
    }

    const login = await control.send(`USER ${target.username}`);
    if (login.code === 331) {
      const pass = await control.send(`PASS ${target.password}`);
      if (pass.code !== 230 && pass.code !== 202) {
        throw new FtpError("auth_failed", "The FTP server did not accept that username and password.");
      }
    } else if (login.code !== 230) {
      throw new FtpError("auth_failed", "The FTP server did not accept that username.");
    }

    await control.send("TYPE I");

    const session: Session = {
      control,
      security,
      host: target.host,
      timeoutMs,
      async data() {
        let dataHost = target.host;
        let dataPort: number | null = null;
        const epsv = await control.send("EPSV");
        if (epsv.code === 229) {
          dataPort = parseEpsv(epsv.text);
        }
        if (dataPort === null) {
          const pasv = await control.send("PASV");
          const parsed = pasv.code === 227 ? parsePasv(pasv.text) : null;
          if (!parsed) throw new FtpError("protocol_error", "The FTP server would not open a data connection.");
          // Some hosts advertise an unroutable internal address; the control
          // host is the address we already know works.
          dataHost = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.host) ? target.host : parsed.host;
          dataPort = parsed.port;
        }
        const plain = await withDeadline(
          Deno.connect({ hostname: dataHost, port: dataPort }),
          timeoutMs,
          "data connect",
        );
        if (security !== "ftps") return plain;
        try {
          return await withDeadline(Deno.startTls(plain, { hostname: target.host }), timeoutMs, "data TLS");
        } catch {
          closeQuietly(plain);
          throw new FtpError("tls_failed", "The secure data connection could not be established.");
        }
      },
    };

    try {
      return await run(session);
    } finally {
      try {
        await control.send("QUIT");
      } catch {
        // Closing anyway.
      }
    }
  } catch (error) {
    return connectFailure(error);
  } finally {
    closeQuietly(current);
    if (raw !== current) closeQuietly(raw);
  }
};

const readAll = async (conn: Conn, maxBytes: number, timeoutMs: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const buf = new Uint8Array(16384);
    const read = await withDeadline(conn.read(buf), timeoutMs, "data read");
    if (read === null) break;
    if (total + read > maxBytes) {
      chunks.push(buf.subarray(0, Math.max(0, maxBytes - total)));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf.subarray(0, read));
    total += read;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

// --- listing parsers --------------------------------------------------------

const parseMlsd = (text: string): FtpEntry[] => {
  const entries: FtpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const split = line.indexOf(" ");
    if (split < 0) continue;
    const facts = line.slice(0, split).split(";");
    const name = line.slice(split + 1).trim();
    if (!name || name === "." || name === "..") continue;
    let kind: FtpEntry["kind"] = "other";
    let size: number | null = null;
    let modifiedAt: string | null = null;
    for (const fact of facts) {
      const [rawKey, rawValue] = fact.split("=");
      const key = (rawKey ?? "").trim().toLowerCase();
      const value = (rawValue ?? "").trim();
      if (key === "type") kind = value === "dir" ? "dir" : value === "file" ? "file" : value === "cdir" || value === "pdir" ? "other" : "other";
      if (key === "size") size = Number(value) || 0;
      if (key === "modify" && /^\d{14}$/.test(value)) {
        modifiedAt = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
      }
    }
    entries.push({ name, kind, size, modifiedAt });
  }
  return entries;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Unix-style `LIST` output, the format nearly every host still emits. */
const parseUnixList = (text: string): FtpEntry[] => {
  const entries: FtpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([dl\-ps])[rwxstST\-]{9}[.+]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3})\s+(\d{1,2})\s+([\d:]{4,5})\s+(.+)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const [, typeChar, size, month, day, timeOrYear, rawName] = match;
    const name = typeChar === "l" ? rawName.split(" -> ")[0] : rawName;
    if (!name || name === "." || name === "..") continue;
    const monthIndex = MONTHS.indexOf(month.toLowerCase());
    let modifiedAt: string | null = null;
    if (monthIndex >= 0) {
      const now = new Date();
      const year = timeOrYear.includes(":") ? now.getUTCFullYear() : Number(timeOrYear);
      const time = timeOrYear.includes(":") ? timeOrYear : "00:00";
      const iso = new Date(Date.UTC(year, monthIndex, Number(day), Number(time.split(":")[0]), Number(time.split(":")[1])));
      if (!Number.isNaN(iso.getTime())) modifiedAt = iso.toISOString();
    }
    entries.push({
      name,
      kind: typeChar === "d" ? "dir" : typeChar === "l" ? "link" : typeChar === "-" ? "file" : "other",
      size: Number(size) || 0,
      modifiedAt,
    });
  }
  return entries;
};

// --- transport --------------------------------------------------------------

const MAX_WRITE_BYTES = 512 * 1024;

export const denoFtpTransport = (): FtpTransport => ({
  async check(target, timeoutMs) {
    return await withSession(target, timeoutMs, async (session) => ({ ok: true as const, security: session.security }));
  },

  async list(target, path, maxEntries, timeoutMs) {
    return await withSession(target, timeoutMs, async (session): Promise<FtpListOutcome> => {
      const collect = async (command: string): Promise<string | null> => {
        const data = await session.data();
        try {
          const started = await session.control.send(`${command} ${path}`);
          if (started.code >= 400) return null;
          const { bytes } = await readAll(data, 512 * 1024, session.timeoutMs);
          closeQuietly(data);
          const done = await session.control.reply();
          if (done.code >= 400) return null;
          return new TextDecoder().decode(bytes);
        } finally {
          closeQuietly(data);
        }
      };

      let entries: FtpEntry[] = [];
      const mlsd = await collect("MLSD");
      if (mlsd !== null) entries = parseMlsd(mlsd);
      if (entries.length === 0) {
        const list = await collect("LIST -la");
        if (list === null) {
          return { ok: false, kind: "not_found", detail: "That folder could not be listed on the server." };
        }
        entries = parseUnixList(list);
      }

      const truncated = entries.length > maxEntries;
      return { ok: true, security: session.security, entries: entries.slice(0, maxEntries), truncated };
    });
  },

  async read(target, path, request, timeoutMs) {
    return await withSession(target, timeoutMs, async (session): Promise<FtpReadOutcome> => {
      const sizeReply = await session.control.send(`SIZE ${path}`);
      const size = sizeReply.code === 213 ? Number(sizeReply.text.trim()) || 0 : null;
      const mdtm = await session.control.send(`MDTM ${path}`);
      const stamp = mdtm.code === 213 ? mdtm.text.trim() : "";
      const modifiedAt = /^\d{14}/.test(stamp)
        ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`
        : null;

      let offset = 0;
      if (request.from === "tail" && size !== null && size > request.maxBytes) offset = size - request.maxBytes;
      if (offset > 0) {
        const rest = await session.control.send(`REST ${offset}`);
        // A server without restart support simply reads from the beginning.
        if (rest.code >= 400) offset = 0;
      }

      const data = await session.data();
      try {
        const started = await session.control.send(`RETR ${path}`);
        if (started.code >= 400) {
          return { ok: false, kind: "not_found", detail: "That file could not be read on the server." };
        }
        const { bytes, truncated } = await readAll(data, request.maxBytes, session.timeoutMs);
        closeQuietly(data);
        await session.control.reply();
        return {
          ok: true,
          security: session.security,
          size,
          bytesRead: bytes.byteLength,
          truncated: truncated || offset > 0,
          text: new TextDecoder().decode(bytes),
          modifiedAt,
        };
      } finally {
        closeQuietly(data);
      }
    });
  },

  async write(target, path, content, options, timeoutMs) {
    const encoded = new TextEncoder().encode(content);
    if (encoded.byteLength > MAX_WRITE_BYTES) {
      return { ok: false, kind: "write_failed", detail: "That file is larger than the 512 KB write limit." };
    }
    return await withSession(target, timeoutMs, async (session): Promise<FtpWriteOutcome> => {
      let backupContent: string | undefined;
      if (options.backupFirst) {
        const data = await session.data();
        try {
          const started = await session.control.send(`RETR ${path}`);
          if (started.code < 400) {
            const { bytes } = await readAll(data, options.maxBackupBytes ?? MAX_WRITE_BYTES, session.timeoutMs);
            closeQuietly(data);
            await session.control.reply();
            backupContent = new TextDecoder().decode(bytes);
          }
        } finally {
          closeQuietly(data);
        }
      }

      const data = await session.data();
      try {
        const started = await session.control.send(`STOR ${path}`);
        if (started.code >= 400) {
          return { ok: false, kind: "write_failed", detail: "The server refused to write that file." };
        }
        await withDeadline(data.write(encoded), session.timeoutMs, "data write");
        closeQuietly(data);
        const done = await session.control.reply();
        if (done.code >= 400) {
          return { ok: false, kind: "write_failed", detail: "The server rejected the file after the transfer." };
        }
        return { ok: true, security: session.security, bytesWritten: encoded.byteLength, backupContent };
      } finally {
        closeQuietly(data);
      }
    });
  },

  async rename(target, from, to, timeoutMs) {
    return await withSession(target, timeoutMs, async (session): Promise<FtpSimpleOutcome> => {
      const rnfr = await session.control.send(`RNFR ${from}`);
      if (rnfr.code !== 350) {
        return { ok: false, kind: "not_found", detail: "The path I was asked to rename is not there." };
      }
      const rnto = await session.control.send(`RNTO ${to}`);
      if (rnto.code >= 400) {
        return { ok: false, kind: "write_failed", detail: "The server refused the rename." };
      }
      return { ok: true, security: session.security };
    });
  },
});
