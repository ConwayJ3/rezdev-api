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
  const { data: all, error } = await req.db
    .from('project_files')
    .select('id, name, storage_url, file_size, mime_type, source, uploaded_at, uploaded_by')
    .eq('project_id', req.params.projectId)
    .order('uploaded_at', { ascending: false });

  if(error) return res.status(400).json({ error: error.message });

  // Being on a project is not permission to read everything filed under it.
  // A contractor sees what was shared with them and nothing else; the client
  // keeps the view they have always had.
  let data = all || [];
  if(req.userRole === 'contractor'){
    const { data: shares } = await supabaseAdmin.from('project_file_shares')
      .select('file_id').eq('user_id', req.userId);
    const allowed = new Set((shares || []).map(function(s){ return s.file_id; }));
    data = data.filter(function(f){ return allowed.has(f.id); });
  }

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

// Who a file is shared with. Builder side only — a contractor has no
// business knowing which other trades hold the same document.
router.get('/:id/shares', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    if(!['owner','builder','pm'].includes(req.userRole)){
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { data: shares } = await supabaseAdmin.from('project_file_shares')
      .select('user_id, shared_at').eq('file_id', req.params.id);
    res.json(shares || []);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

router.post('/:id/shares', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    if(!['owner','builder','pm'].includes(req.userRole)){
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { user_id } = req.body;
    if(!user_id) return res.status(400).json({ error: 'user_id required' });

    // The file must belong to this project, and the recipient must be on it.
    const { data: file } = await supabaseAdmin.from('project_files')
      .select('id').eq('id', req.params.id).eq('project_id', req.params.projectId).maybeSingle();
    if(!file) return res.status(404).json({ error: 'File not found on this project' });

    const { data: assigned } = await supabaseAdmin.from('project_contractors')
      .select('id').eq('project_id', req.params.projectId).eq('user_id', user_id).limit(1);
    if(!assigned || !assigned.length){
      return res.status(400).json({ error: 'That contractor is not assigned to this project' });
    }

    const { error } = await supabaseAdmin.from('project_file_shares')
      .upsert({ file_id: req.params.id, user_id: user_id, shared_by: req.userId },
              { onConflict: 'file_id,user_id' });
    if(error) return res.status(400).json({ error: error.message });
    res.status(201).json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

router.delete('/:id/shares/:userId', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    if(!['owner','builder','pm'].includes(req.userRole)){
      return res.status(403).json({ error: 'Not authorized' });
    }
    await supabaseAdmin.from('project_file_shares')
      .delete().eq('file_id', req.params.id).eq('user_id', req.params.userId);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /projects/:projectId/files/:id/download — get fresh signed URL
router.get('/:id/download', requireAuth, requireProjectAccess, async (req, res) => {
  // A direct download must respect sharing too, or the list filter is
  // decoration — the id is guessable from any shared file's response.
  if(req.userRole === 'contractor'){
    const { data: share } = await supabaseAdmin.from('project_file_shares')
      .select('id').eq('file_id', req.params.id).eq('user_id', req.userId).limit(1);
    if(!share || !share.length){
      return res.status(403).json({ error: 'That file has not been shared with you' });
    }
  }
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
