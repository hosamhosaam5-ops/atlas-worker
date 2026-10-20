// DNSExit SMTP transport for Cloudflare Workers TCP sockets.
// No credentials, recipients, subjects, or message bodies are logged.
export class SmtpFailure extends Error {}

export async function sendDnsExitSmtp(env, msg, connectOverride) {
  const host = env.DNS_EXIT_SMTP_HOST || 'relay.dnsexit.com';
  const port = Number(env.DNS_EXIT_SMTP_PORT || 587);
  const username = env.DNS_EXIT_SMTP_USERNAME;
  const password = env.DNS_EXIT_SMTP_PASSWORD;
  const from = env.EMAIL_FROM;
  if (!username || !password || !from) throw new SmtpFailure('smtp provider is not configured');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SmtpFailure('smtp port is invalid');
  if (!validAddress(msg?.to) || !validAddress(from)) throw new SmtpFailure('invalid sender or recipient');
  if (/[\r\n]/.test(String(msg.subject || '')) || /[\r\n]/.test(from) || /[\r\n]/.test(msg.to)) {
    throw new SmtpFailure('invalid email headers');
  }

  let connect = connectOverride;
  if (!connect) ({ connect } = await import('cloudflare:sockets'));
  let socket;
  let session;
  try {
    socket = connect({ hostname: host, port }, { secureTransport: 'starttls' });
    await socket.opened;
    session = new SmtpSession(socket);
    await session.expect(220, 'smtp greeting');
    await session.command('EHLO atlas-worker.local', 250, 'smtp ehlo');
    if (!/\bSTARTTLS\b/i.test(session.lastResponse)) throw new SmtpFailure('smtp server does not offer STARTTLS');
    await session.command('STARTTLS', 220, 'smtp starttls');
    await session.upgradeTls();
    socket = session.socket;
    await session.command('EHLO atlas-worker.local', 250, 'smtp ehlo after tls');
    await session.command('AUTH LOGIN', 334, 'smtp auth');
    await session.command(toBase64(username), 334, 'smtp username');
    await session.command(toBase64(password), 235, 'smtp password');
    await session.command('MAIL FROM:<' + from + '>', 250, 'smtp mail from');
    await session.command('RCPT TO:<' + msg.to + '>', [250, 251], 'smtp recipient');
    await session.command('DATA', 354, 'smtp data');
    const data = normalizeCrlf(buildMime(from, msg)).replace(/(^|\r\n)\./g, '$1..');
    await session.write(data.endsWith('\r\n') ? data + '.\r\n' : data + '\r\n.\r\n');
    await session.expect(250, 'smtp message acceptance');
    // Acceptance has been confirmed; QUIT is best-effort and must not turn success into failure.
    try { await session.command('QUIT', 221, 'smtp quit'); } catch {}
    return 'dnsexit-' + Date.now().toString(36);
  } catch (error) {
    if (error instanceof SmtpFailure) throw error;
    throw new SmtpFailure('smtp transport failed');
  } finally {
    try { await (session?.socket || socket)?.close(); } catch {}
  }
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.reader = socket.readable.getReader();
    this.lastResponse = '';
  }
  async write(text) {
    const writer = this.socket.writable.getWriter();
    try { await writer.write(new TextEncoder().encode(text)); }
    finally { writer.releaseLock(); }
  }
  async line() {
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new SmtpFailure('smtp connection closed unexpectedly');
      this.buffer += this.decoder.decode(value, { stream: true });
      if (this.buffer.length > 65536) throw new SmtpFailure('smtp response too large');
    }
  }
  async response() {
    const lines = [];
    let code = null;
    for (let i = 0; i < 30; i++) {
      const line = await this.line();
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) throw new SmtpFailure('smtp response malformed');
      if (code === null) code = Number(match[1]);
      if (Number(match[1]) !== code) throw new SmtpFailure('smtp response malformed');
      lines.push(line);
      if (match[2] === ' ') {
        this.lastResponse = lines.join('\n');
        return { code, text: this.lastResponse };
      }
    }
    throw new SmtpFailure('smtp response too long');
  }
  async expect(codes, label) {
    const response = await this.response();
    const allowed = Array.isArray(codes) ? codes : [codes];
    if (!allowed.includes(response.code)) throw new SmtpFailure(label + ' rejected (SMTP ' + response.code + ')');
    this.lastResponse = response.text;
    return response;
  }
  async command(command, codes, label) {
    await this.write(command + '\r\n');
    return this.expect(codes, label);
  }
  async upgradeTls() {
    this.reader.releaseLock();
    this.socket = this.socket.startTls();
    await this.socket.opened;
    this.reader = this.socket.readable.getReader();
    this.buffer = '';
    this.decoder = new TextDecoder();
  }
}

function validAddress(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}
function toBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function encodeHeader(value) {
  const text = String(value || '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return '=?UTF-8?B?' + toBase64(text) + '?=';
}
function normalizeCrlf(value) { return String(value).replace(/\r?\n/g, '\r\n'); }
function base64FromBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
function wrapBase64(value) { return value.match(/.{1,76}/g)?.join('\r\n') || ''; }

function buildMime(from, msg) {
  const to = msg.to;
  const subject = encodeHeader(msg.subject || 'ATLAS notification');
  const body = String(msg.text || '');
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const headers = 'From: <' + from + '>\r\nTo: <' + to + '>\r\nSubject: ' + subject + '\r\nMIME-Version: 1.0\r\n';
  if (!attachments.length) {
    return headers + 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' + body + '\r\n';
  }
  const boundary = 'atlas_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = [
    headers + 'Content-Type: multipart/mixed; boundary="' + boundary + '"\r\n\r\n',
    '--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' + body + '\r\n',
  ];
  for (const attachment of attachments) {
    const name = String(attachment.file_name || 'attachment.bin').replace(/[\r\n"\\]/g, '_');
    parts.push('--' + boundary + '\r\nContent-Type: application/octet-stream; name="' + name + '"\r\nContent-Disposition: attachment; filename="' + name + '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrapBase64(base64FromBytes(attachment.bytes)) + '\r\n');
  }
  parts.push('--' + boundary + '--\r\n');
  return parts.join('');
}
