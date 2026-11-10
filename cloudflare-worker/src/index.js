const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: corsHeaders(origin, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    })
  });
}

function corsHeaders(origin, extra) {
  const headers = new Headers(extra || {});
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Chat-Peer, X-File-Name");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
}

function safeFilename(value) {
  const name = String(value || "attachment")
    .split(/[\\/]/).pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return name || "attachment";
}

function allowedContentType(value) {
  const type = String(value || "application/octet-stream").split(";")[0].trim().toLowerCase();
  return type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    ALLOWED_TYPES.has(type);
}

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const lookup = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
      encodeURIComponent(env.FIREBASE_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: match[1] })
    }
  );
  if (!lookup.ok) return null;

  const account = await lookup.json();
  const user = account && account.users && account.users[0];
  if (!user || !user.localId || !user.email) return null;

  const email = String(user.email).toLowerCase();
  const ownerEmail = String(env.FIREBASE_OWNER_EMAIL || "").toLowerCase();

  if (email !== ownerEmail) {
    const approvalUrl =
      "https://firestore.googleapis.com/v1/projects/" +
      encodeURIComponent(env.FIREBASE_PROJECT_ID) +
      "/databases/(default)/documents/allowed/" +
      encodeURIComponent(email);

    const approval = await fetch(approvalUrl, {
      headers: { Authorization: "Bearer " + match[1] }
    });
    if (!approval.ok) return null;
  }

  return { uid: user.localId, email: email };
}

function roomKey(uid, peerUid) {
  return [uid, peerUid].sort().join("_");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://neoxtasis.github.io";

    if (origin && origin !== allowedOrigin) {
      return new Response("Origin not allowed.", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin)
      });
    }

    if (!env.MEDIA_BUCKET || !env.FIREBASE_API_KEY || !env.FIREBASE_PROJECT_ID) {
      return json({ error: "Media service is not configured." }, 503, allowedOrigin);
    }

    const user = await authenticate(request, env).catch(() => null);
    if (!user) return json({ error: "Authentication or Chatbox access was denied." }, 401, allowedOrigin);

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/upload") {
      const peerUid = String(request.headers.get("X-Chat-Peer") || "").trim();
      if (!peerUid || peerUid === user.uid || peerUid.length > 128) {
        return json({ error: "A valid conversation recipient is required." }, 400, allowedOrigin);
      }

      const contentType = String(request.headers.get("Content-Type") || "application/octet-stream");
      if (!allowedContentType(contentType)) {
        return json({ error: "This file type is not supported." }, 415, allowedOrigin);
      }

      const declaredLength = Number(request.headers.get("Content-Length") || 0);
      if (declaredLength > MAX_UPLOAD_BYTES) {
        return json({ error: "Files must be 50 MB or smaller." }, 413, allowedOrigin);
      }

      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength) return json({ error: "The selected file is empty." }, 400, allowedOrigin);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return json({ error: "Files must be 50 MB or smaller." }, 413, allowedOrigin);
      }

      const filename = safeFilename(request.headers.get("X-File-Name"));
      const key = roomKey(user.uid, peerUid) + "/" + crypto.randomUUID() + "-" + filename;
      const cleanType = contentType.split(";")[0].trim().toLowerCase();

      await env.MEDIA_BUCKET.put(key, bytes, {
        httpMetadata: {
          contentType: cleanType,
          contentDisposition: "inline; filename=\"" + filename.replace(/["\\]/g, "_") + "\"",
          cacheControl: "private, no-store"
        },
        customMetadata: {
          ownerUid: user.uid,
          peerUid: peerUid,
          originalName: filename
        }
      });

      return json({
        key: key,
        url: "/media/" + key,
        name: filename,
        type: cleanType,
        size: bytes.byteLength
      }, 201, allowedOrigin);
    }

    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      const key = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\")) {
        return json({ error: "Invalid media reference." }, 400, allowedOrigin);
      }

      const head = await env.MEDIA_BUCKET.head(key);
      if (!head) return json({ error: "Media not found." }, 404, allowedOrigin);

      const metadata = head.customMetadata || {};
      if (metadata.ownerUid !== user.uid && metadata.peerUid !== user.uid) {
        return json({ error: "You are not a participant in this conversation." }, 403, allowedOrigin);
      }

      let object;
      let status = 200;
      const rangeHeader = request.headers.get("Range");
      const rangeMatch = rangeHeader && rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (rangeHeader && !rangeMatch) {
        return new Response(null, {
          status: 416,
          headers: corsHeaders(allowedOrigin, {
            "Content-Range": "bytes */" + head.size,
            "Accept-Ranges": "bytes"
          })
        });
      }

      if (rangeMatch) {
        let start = rangeMatch[1] ? Number(rangeMatch[1]) : null;
        let end = rangeMatch[2] ? Number(rangeMatch[2]) : null;
        if (start === null) {
          const suffixLength = end;
          if (!suffixLength || suffixLength < 0) {
            return new Response(null, { status: 416, headers: corsHeaders(allowedOrigin, { "Content-Range": "bytes */" + head.size }) });
          }
          start = Math.max(0, head.size - suffixLength);
          end = head.size - 1;
        } else {
          if (end === null || end >= head.size) end = head.size - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= head.size) {
          return new Response(null, { status: 416, headers: corsHeaders(allowedOrigin, { "Content-Range": "bytes */" + head.size }) });
        }
        object = await env.MEDIA_BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
        status = 206;
      } else {
        object = await env.MEDIA_BUCKET.get(key);
      }
      if (!object) return json({ error: "Media not found." }, 404, allowedOrigin);

      const headers = corsHeaders(allowedOrigin);
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
      if (status === 206) {
        const start = rangeMatch[1] ? Number(rangeMatch[1]) : Math.max(0, head.size - Number(rangeMatch[2]));
        const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), head.size - 1) : head.size - 1;
        headers.set("Content-Range", "bytes " + start + "-" + end + "/" + head.size);
        headers.set("Content-Length", String(end - start + 1));
      } else {
        headers.set("Content-Length", String(head.size));
      }
      return new Response(object.body, { status: status, headers });
    }

    return json({ error: "Not found." }, 404, allowedOrigin);
  }
};
