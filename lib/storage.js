const { supabaseAdmin } = require('./supabase');

const BUCKETS = {
  files:      process.env.STORAGE_BUCKET_FILES      || 'project-files',
  selections: process.env.STORAGE_BUCKET_SELECTIONS || 'selections',
  drive:      process.env.STORAGE_BUCKET_DRIVE      || 'drive',
  contracts:  process.env.STORAGE_BUCKET_CONTRACTS  || 'contracts',
  avatars:    process.env.STORAGE_BUCKET_AVATARS    || 'avatars',
  logos:      process.env.STORAGE_BUCKET_LOGOS      || 'logos',
  // Customer-uploaded brand assets, kept apart from RezDev's own so the two
  // can't collide or share policies.
  companyLogos: process.env.STORAGE_BUCKET_COMPANY_LOGOS || 'company-logos',
};

/**
 * Upload a file buffer to Supabase Storage
 * @param {string} bucket  - bucket name key from BUCKETS
 * @param {string} path    - storage path e.g. 'project-id/filename.pdf'
 * @param {Buffer} buffer  - file data
 * @param {string} mimeType
 * @returns {string} public or signed URL
 */
async function uploadFile(bucket, path, buffer, mimeType) {
  const bucketName = BUCKETS[bucket] || bucket;
  const { data, error } = await supabaseAdmin.storage
    .from(bucketName)
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,
    });
  if(error) throw error;
  return data.path;
}

/**
 * Get a signed URL for private file access (1 hour expiry)
 */
async function getSignedUrl(bucket, path, expiresIn = 3600) {
  const bucketName = BUCKETS[bucket] || bucket;
  const { data, error } = await supabaseAdmin.storage
    .from(bucketName)
    .createSignedUrl(path, expiresIn);
  if(error) throw error;
  return data.signedUrl;
}

/**
 * Delete a file from storage
 */
async function deleteFile(bucket, path) {
  const bucketName = BUCKETS[bucket] || bucket;
  const { error } = await supabaseAdmin.storage
    .from(bucketName)
    .remove([path]);
  if(error) throw error;
}

/**
 * Get public URL (for public buckets like avatars/logos)
 */
function getPublicUrl(bucket, path) {
  const bucketName = BUCKETS[bucket] || bucket;
  const { data } = supabaseAdmin.storage
    .from(bucketName)
    .getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Turn whatever we have stored into a usable, time-limited URL.
 *
 * Historic rows hold FULL PUBLIC URLs from when the contracts bucket was
 * public. The storage path is recoverable from them, so no data migration is
 * needed — this strips the public prefix and signs the path instead. Bare
 * paths and already-signed URLs are handled too.
 *
 * Returns null if there's nothing usable.
 */
async function resolveStorageUrl(bucket, stored, expiresIn = 3600) {
  if(!stored) return null;
  const s = String(stored);

  // Already a signed URL — reuse it rather than re-signing.
  if(s.indexOf('/object/sign/') !== -1) return s;

  let path = s;
  const publicMarker = '/object/public/';
  const i = s.indexOf(publicMarker);
  if(i !== -1){
    // .../object/public/<bucket>/<path>
    const after = s.slice(i + publicMarker.length);
    const slash = after.indexOf('/');
    path = slash === -1 ? after : after.slice(slash + 1);
    try { path = decodeURIComponent(path); } catch(e){ /* leave as-is */ }
  } else if(/^https?:\/\//i.test(s)){
    // Some other absolute URL (e.g. an external host) — pass it through.
    return s;
  }

  try {
    return await getSignedUrl(bucket, path, expiresIn);
  } catch(e){
    console.error('[storage] sign failed:', bucket, '|', path, '|', e && e.message);
    // Fall back to whatever we were given. On a public bucket that still
    // works; on a private one the caller gets a clear failure rather than a
    // null that renders as href="null".
    return /^https?:\/\//i.test(s) ? s : null;
  }
}

module.exports = { uploadFile, getSignedUrl, deleteFile, getPublicUrl, resolveStorageUrl, BUCKETS };
