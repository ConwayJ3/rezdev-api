const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { uploadFile, getSignedUrl, deleteFile } = require('../lib/storage');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50*1024*1024 } });

// Seed system folders for a company if they don't exist
async function seedSystemFolders(companyId){
  const { data } = await supabaseAdmin.from('drive_folders').select('id').eq('company_id', companyId).eq('system', true);
  if(data && data.length > 0) return;
  const systemFolders = [
    { name:'Branding',   icon:'🎨', visibility:'everyone', allowed_roles:['builder','pm','client'] },
    { name:'Legal',      icon:'⚖️',  visibility:'role',     allowed_roles:['builder'] },
    { name:'Operations', icon:'⚙️',  visibility:'everyone', allowed_roles:['builder','pm'] },
    { name:'Financial',  icon:'💰', visibility:'role',     allowed_roles:['builder'] },
  ];
  for(const f of systemFolders){
    await supabaseAdmin.from('drive_folders').insert({ ...f, company_id: companyId, system: true });
  }
}

// GET /drive/folders
router.get('/folders', requireAuth, async (req, res) => {
  try {
    await seedSystemFolders(req.companyId);
    const { data, error } = await supabaseAdmin
      .from('drive_folders')
      .select('*')
      .eq('company_id', req.companyId)
      .order('created_at');
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// POST /drive/folders
router.post('/folders', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { name, icon, parent_id, visibility, allowed_roles } = req.body;
    if(!name) return res.status(400).json({ error: 'name required' });
    const { data, error } = await supabaseAdmin
      .from('drive_folders')
      .insert({ company_id: req.companyId, name, icon: icon||'📁', parent_id: parent_id||null, visibility: visibility||'everyone', allowed_roles: allowed_roles||['builder','pm'], created_by: req.userId })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// DELETE /drive/folders/:id
router.delete('/folders/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const { data: folder } = await supabaseAdmin.from('drive_folders').select('system').eq('id', req.params.id).single();
    if(folder?.system) return res.status(400).json({ error: 'Cannot delete system folders' });
    await supabaseAdmin.from('drive_folders').delete().eq('id', req.params.id).eq('company_id', req.companyId);
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /drive/files
router.get('/files', requireAuth, async (req, res) => {
  try {
    const q = supabaseAdmin.from('drive_files').select('*, users(first_name, last_name)').eq('company_id', req.companyId);
    if(req.query.folder_id) q.eq('folder_id', req.query.folder_id);
    const { data, error } = await q.order('uploaded_at', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// POST /drive/files — upload
router.post('/files', requireAuth, upload.array('files', 20), async (req, res) => {
  try {
    if(!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
    const { folder_id } = req.body;
    const uploaded = [];
    for(const file of req.files){
      try {
        const storagePath = `drive/${req.companyId}/${Date.now()}_${file.originalname}`;
        const path = await uploadFile('drive', storagePath, file.buffer, file.mimetype);
        const { data } = await supabaseAdmin.from('drive_files').insert({
          company_id:  req.companyId,
          folder_id:   folder_id || null,
          name:        file.originalname,
          storage_url: path,
          file_size:   file.size,
          mime_type:   file.mimetype,
          uploaded_by: req.userId,
        }).select().single();
        if(data) uploaded.push(data);
      } catch(e){ console.error('Drive upload error:', e.message); }
    }
    res.status(201).json(uploaded);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// DELETE /drive/files/:id
router.delete('/files/:id', requireAuth, async (req, res) => {
  try {
    const { data: file } = await supabaseAdmin.from('drive_files').select('storage_url, uploaded_by').eq('id', req.params.id).single();
    if(!file) return res.status(404).json({ error: 'File not found' });
    const canDelete = ['owner','builder'].includes(req.userRole) || file.uploaded_by === req.userId;
    if(!canDelete) return res.status(403).json({ error: 'Cannot delete this file' });
    if(file.storage_url) await deleteFile('drive', file.storage_url).catch(()=>{});
    await supabaseAdmin.from('drive_files').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

module.exports = router;
