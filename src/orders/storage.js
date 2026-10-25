// D1-only file storage adapter. Order Intake never needs to know the storage backend.
export function getFileStorage(_env = {}) {
  return {
    kind: 'D1',
    async put(db, orderId, fileKind, fileName, bytes) {
      const b64 = base64FromBytes(bytes);
      // UNIQUE(order_id, file_kind) — duplicates are rejected by D1, never silently overwritten.
      await db.prepare(
        'INSERT INTO order_files (order_id, file_kind, file_name, content_base64) VALUES (?, ?, ?, ?)'
      ).bind(orderId, fileKind, fileName, b64).run();
      return { stored: true, file_kind: fileKind, file_name: fileName, bytes: bytes.length };
    },
    async get(db, orderId, fileKind) {
      const row = await db.prepare(
        'SELECT file_name, content_base64 FROM order_files WHERE order_id = ? AND file_kind = ?'
      ).bind(orderId, fileKind).first();
      if (!row) return null;
      return { file_name: row.file_name, bytes: bytesFromBase64(row.content_base64) };
    },
  };
}

export function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
