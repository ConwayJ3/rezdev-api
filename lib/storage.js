const { supabaseAdmin } = require('./supabase');

const BUCKETS = {
  files:      process.env.STORAGE_BUCKET_FILES      || 'project-files',
  selections: process.env.STORAGE_BUCKET_SELECTIONS || 'selections',
  drive:      process.env.STORAGE_BUCKET_DRIVE      || 'drive',
  contracts:  process.env.STORAGE_BUCKET_CONTRACTS  || 'contracts',
  avatars:    process.env.STORAGE_BUCKET_AVATARS    || 'avatars',
  logos:      process.env.STORAGE_BUCKET_LOGOS      || 'logos',
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

module.exports = { uploadFile, getSignedUrl, deleteFile, getPublicUrl, BUCKETS };
