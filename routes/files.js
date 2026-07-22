const express = require('express');
const multer  = require('multer');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { uploadFile, getSignedUrl, deleteFile } = require('../lib/storage');
const { requireAuth, requireProjectAccess } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// GET /projects/:projectId/files
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('project_files')
    .select('id, name, storage_url, file_size, mime_type, source, uploaded_at, uploaded_by')
    .eq('project_id', req.params.projectId)
    .order('uploaded_at', { ascending: false });

  if(error) return res.status(400).json({ error: error.message });

  // Generate signed URLs for each file
  const filesWithUrls = await Promise.all(data.map(async f => {
    try {
      const url = await getSignedUrl('files', f.storage_url);
      return { ...f, signed_url: url };
    } catch(e) {
      return { ...f, signed_url: null };
    }
  }));

  res.json(filesWithUrls);
});

// POST /projects/:projectId/files — multipart upload
router.post('/', requireAuth, requireProjectAccess, upload.array('files', 20), async (req, res) => {
  if(!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const uploaded = [];
  const projectId = req.params.projectId;

  for(const file of req.files) {
    const ext  = file.originalname.split('.').pop();
    const path = `${projectId}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g,'_')}`;

    try {
      console.log('[Files] Upload start:', file.originalname, 'role:', req.userRole, 'userId:', req.userId, 'projectId:', projectId);
      const storagePath = await uploadFile('files', path, file.buffer, file.mimetype);
      console.log('[Files] Storage upload OK:', storagePath);

      const { data, error } = await supabaseAdmin
        .from('project_files')
        .insert({
          project_id:  projectId,
          name:        file.originalname,
          storage_url: storagePath,
          file_size:   file.size,
          mime_type:   file.mimetype,
          source:      ['builder','pm','client','contractor'].includes(req.userRole) ? req.userRole : 'builder',
          uploaded_by: req.userId,
        })
        .select()
        .single();

      if(!error) uploaded.push(data);
    } catch(e) {
      console.error('File upload error:', e.message);
    }
  }

  res.status(201).json(uploaded);
});

// DELETE /projects/:projectId/files/:id
router.delete('/:id', requireAuth, requireProjectAccess, async (req, res) => {
  const { data: file } = await supabaseAdmin
    .from('project_files')
    .select('storage_url, uploaded_by')
    .eq('id', req.params.id)
    .single();

  if(!file) return res.status(404).json({ error: 'File not found' });

  // Only uploader or builder/owner can delete
  const canDelete = ['owner','builder'].includes(req.userRole) || file.uploaded_by === req.userId;
  if(!canDelete) return res.status(403).json({ error: 'Cannot delete this file' });

  await deleteFile('files', file.storage_url).catch(() => {});

  const { error } = await supabaseAdmin
    .from('project_files')
    .delete()
    .eq('id', req.params.id);

  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// GET /projects/:projectId/files/:id/download — get fresh signed URL
router.get('/:id/download', requireAuth, requireProjectAccess, async (req, res) => {
  const { data: file } = await supabaseAdmin
    .from('project_files')
    .select('storage_url, name, mime_type')
    .eq('id', req.params.id)
    .single();

  if(!file) return res.status(404).json({ error: 'File not found' });

  try {
    const url = await getSignedUrl('files', file.storage_url, 300); // 5 min
    res.json({ url, name: file.name, mime_type: file.mime_type });
  } catch(e) {
    console.error('[Files] Signed URL error:', e && (e.message || e), '| path:', file.storage_url);
    res.status(500).json({ error: 'Could not generate download URL', detail: e && e.message });
  }
});

module.exports = router;
