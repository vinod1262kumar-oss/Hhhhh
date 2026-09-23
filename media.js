// functions/media.js
// Uploads media selected from the phone gallery and serves it back as a public
// URL. Files are stored in Netlify Blobs as plain bytes, in small chunks so a
// short phone video doesn't need to fit in one request. Content type is stored
// as a small separate JSON record — the same get/set-JSON pattern already used
// successfully in listings.js / leads.js / visits.js / settings.js — rather
// than relying on the Blobs "metadata" option or the Blob constructor, whose
// exact behavior across Netlify's runtime isn't something this project can
// verify without live logs.

import { getStore } from '@netlify/blobs';

const ADMIN_PASSWORD = 'Mishra ji';
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 900 * 1024; // raw bytes per chunk, before base64 — kept
                                     // well under Netlify's function payload
                                     // ceiling even after base64 inflation.

function json(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function cleanId(value){
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function bytesFromBase64(value){
  const bin = Buffer.from(value || '', 'base64');
  return new Uint8Array(bin);
}

function concatBytes(chunks, totalLength){
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for(const chunk of chunks){
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

export default async (req) => {
  let store;
  try{
    store = getStore('mpd-media');
  }catch(e){
    return json({ error: 'Storage is not available right now: ' + e.message }, 500);
  }

  if(req.method === 'GET'){
    const id = cleanId(new URL(req.url).searchParams.get('id'));
    if(!id) return new Response('Missing media id', { status: 400 });

    try{
      const bytes = await store.get(`media/${id}`, { type: 'arrayBuffer' });
      if(!bytes) return new Response('Media not found', { status: 404 });

      const meta = (await store.get(`media-meta/${id}`, { type: 'json' })) || {};
      const contentType = meta.contentType || 'application/octet-stream';

      return new Response(bytes, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }catch(e){
      return new Response('Could not read media: ' + e.message, { status: 500 });
    }
  }

  if(req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await req.json().catch(() => null);
  if(!body) return json({ error: 'Could not read the upload request.' }, 400);
  if(body.password !== ADMIN_PASSWORD) return json({ error: 'Unauthorized' }, 401);

  const action = body.action || 'chunk';
  if(action !== 'chunk') return json({ error: 'Unknown action' }, 400);

  const uploadId = cleanId(body.uploadId);
  const index = Number(body.index);
  const total = Number(body.total);
  const mime = String(body.mime || 'application/octet-stream');
  const kind = body.kind === 'video' ? 'video' : 'image';

  if(!uploadId || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total){
    return json({ error: 'Invalid upload chunk.' }, 400);
  }

  let chunk;
  try{
    chunk = bytesFromBase64(body.data);
  }catch(e){
    return json({ error: 'Could not decode the uploaded data: ' + e.message }, 400);
  }

  if(chunk.byteLength > MAX_CHUNK_BYTES + 1024){ // small slack for base64 rounding
    return json({ error: 'That chunk is larger than expected — please try again.' }, 413);
  }

  try{
    await store.set(`chunks/${uploadId}/${index}`, chunk);
  }catch(e){
    return json({ error: 'Could not save that part of the upload: ' + e.message }, 500);
  }

  if(body.final !== true) return json({ ok: true, index });

  try{
    const parts = [];
    let totalBytes = 0;
    const max = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

    for(let i = 0; i < total; i++){
      const part = await store.get(`chunks/${uploadId}/${i}`, { type: 'arrayBuffer' });
      if(!part) return json({ error: `Upload is incomplete — part ${i + 1} of ${total} is missing. Please try again.` }, 400);
      const bytes = new Uint8Array(part);
      totalBytes += bytes.byteLength;
      if(totalBytes > max){
        return json({ error: `${kind === 'video' ? 'Video' : 'Image'} is too large.` }, 413);
      }
      parts.push(bytes);
    }

    const combined = concatBytes(parts, totalBytes);
    const mediaId = `${kind}-${uploadId}`;

    await store.set(`media/${mediaId}`, combined);
    await store.setJSON(`media-meta/${mediaId}`, { contentType: mime, size: totalBytes, kind });

    for(let i = 0; i < total; i++){
      try{ await store.delete(`chunks/${uploadId}/${i}`); }catch(_){ /* best effort cleanup */ }
    }

    return json({
      ok: true,
      id: mediaId,
      url: `/.netlify/functions/media?id=${encodeURIComponent(mediaId)}`,
      mime,
      size: totalBytes
    });
  }catch(e){
    return json({ error: 'Could not finish saving the upload: ' + e.message }, 500);
  }
};
