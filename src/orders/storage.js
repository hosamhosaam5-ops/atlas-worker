// M4 File Storage Adapter — FILE_STORAGE=LOCAL (D1 order_files table, default) | R2 (M5+).
// Order Intake core never sees where bytes live.

export function getFileStorage(env) {
  const kind = env.FILE_STORAGE || 'LOCAL';
  if (kind === 'LOCAL') {
    return {
      kind,
      async put(db, orderId, fileKind, fileName, bytes) {
        const b64 = base64FromBytes(bytes);
        // UNIQUE(order_id, file_kind) — a second put for the same order/kind is rejected
        // at DB level, not overwritten silently.
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
  if (kind === 'R2') {
    // Production path (M5+): env.R2 bucket binding. Same put/get contract.
    return {
      kind,
      async put(db, orderId, fileKind, fileName, bytes) {
        await env.R2.put(`orders/${orderId}/${fileKind}`, bytes, { httpMetadata: {} });
        return { stored: true, file_kind: fileKind, file_name: fileName, bytes: bytes.length };
      },
      async get(db, orderId, fileKind) {
        const obj = await env.R2.get(`orders/${orderId}/${fileKind}`);
        if (!obj) return null;
        const buf = new Uint8Array(await obj.arrayBuffer());
        return { file_name: fileKind, bytes: buf };
      },
    };
  }
  throw new Error('unknown FILE_STORAGE: ' + kind);
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
