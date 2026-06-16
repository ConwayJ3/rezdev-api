const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');

// GET /projects — list all projects for this company
router.get('/', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role;

    // Contractor: only return projects they are assigned to
    if(role === 'contractor'){
      const { data: assignments } = await supabaseAdmin
        .from('project_contractors')
        .select('project_id')
        .eq('user_id', req.userId);
      const projectIds = (assignments||[]).map(a => a.project_id);
      if(!projectIds.length) return res.json([]);
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, project_key, name, address, city, state, status, project_type, beds, baths, livable_sf, total_sf, created_at, updated_at, phases(id, name, status, start_date, end_date, sort_order)')
        .in('id', projectIds)
        .order('created_at', { ascending: false });
      if(error) return res.status(400).json({ error: error.message });
      return res.json(data);
    }

    // Client: only return linked projects
    if(role === 'client'){
      const { data: linked } = await supabaseAdmin
        .from('project_clients')
        .select('project_id')
        .eq('user_id', req.userId);
      const projectIds = (linked||[]).map(l => l.project_id);
      if(!projectIds.length) return res.json([]);
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, project_key, name, address, city, state, status, project_type, beds, baths, livable_sf, total_sf, created_at, updated_at, phases(id, name, status, start_date, end_date, sort_order)')
        .in('id', projectIds)
        .order('created_at', { ascending: false });
      if(error) return res.status(400).json({ error: error.message });
      return res.json(data);
    }

    // Builder/PM/Owner: return all company projects
    const { data, error } = await req.db
      .from('projects')
      .select('id, project_key, name, address, city, state, status, project_type, beds, baths, livable_sf, total_sf, group_id, created_at, updated_at, phases(id, name, status, start_date, end_date, sort_order), budget_configs(total_budget, build_budget)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });

    // Attach group names for grouped projects
    const groupIds = [...new Set((data||[]).map(p => p.group_id).filter(Boolean))];
    if(groupIds.length){
      const { data: groups } = await supabaseAdmin.from('lot_groups').select('id, name').in('id', groupIds);
      const groupMap = {};
      (groups||[]).forEach(g => { groupMap[g.id] = g.name; });
      (data||[]).forEach(p => { if(p.group_id) p.group_name = groupMap[p.group_id]; });
    }
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /projects/groups — lot groups with members
router.get('/groups', requireAuth, async (req, res) => {
  const { data, error } = await req.db
    .from('lot_groups')
    .select(`
      id, name, area, client, budget_per_lot, created_at,
      lot_group_members(
        id, lot_name, lot_number, status, progress, budget, address, sort_order,
        project_id,
        projects(id, name, status)
      )
    `)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/groups — create a new lot group
router.post('/groups', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { name, area, client, budget_per_lot, lots } = req.body;
  if(!name) return res.status(400).json({ error: 'Group name is required' });

  // Create the group
  const { data: group, error: groupErr } = await supabaseAdmin
    .from('lot_groups')
    .insert({ name, area, client, budget_per_lot: budget_per_lot||0, company_id: req.companyId })
    .select()
    .single();

  if(groupErr) return res.status(400).json({ error: groupErr.message });

  // Create individual lot projects and group members
  if(lots && lots.length) {
    for(let i=0; i<lots.length; i++) {
      const lot = lots[i];
      // Create the project
      const { data: proj, error: projErr } = await supabaseAdmin
        .from('projects')
        .insert({
          company_id:   req.companyId,
          name:         lot.name || `Lot ${i+1}`,
          address:      lot.address || '',
          status:       'planning',
          created_by:   req.userId,
          group_id:     group.id,
        })
        .select()
        .single();
      if(projErr) continue;

      // Link to group
      await supabaseAdmin.from('lot_group_members').insert({
        group_id:   group.id,
        project_id: proj.id,
        lot_name:   lot.name || `Lot ${i+1}`,
        lot_number: i+1,
        status:     'planning',
        budget:     lot.budget || budget_per_lot || 0,
        sort_order: i,
      });
    }
  }

  const { data: full } = await supabaseAdmin
    .from('lot_groups')
    .select(`id, name, area, client, budget_per_lot, lot_group_members(*)`)
    .eq('id', group.id)
    .single();

  res.status(201).json(full);
});

// GET /projects/:id
router.get('/:id', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('projects')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if(error) return res.status(404).json({ error: 'Project not found' });
  res.json(data);
});

// POST /projects
router.post('/', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { name, address, city, state, zip, county, project_type, notes } = req.body;
  if(!name) return res.status(400).json({ error: 'Project name is required' });

  const { data, error } = await supabaseAdmin
    .from('projects')
    .insert({
      company_id: req.companyId,
      name, address, city, state, zip, county, project_type, notes,
      created_by: req.userId,
    })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /projects/:id — update project info
router.put('/:id', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const allowed = ['name','address','city','state','zip','county','neighborhood',
    'status','project_type','beds','baths','livable_sf','total_sf','lot_area',
    'site_width','site_depth','lot','block','zoning_district','coverage_ratio',
    'front_setback','rear_setback','side_setback','max_height','notes'];
  const updates = {};
  allowed.forEach(k => { if(req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('projects')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /projects/:id
router.delete('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('projects')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);

  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// GET /projects/:id/clients — clients linked to project
router.get('/:id/clients', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('project_clients')
    .select('*')
    .eq('project_id', req.params.id);

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/:id/clients — link a client to a project
router.post('/:id/clients', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { client_name, email, phone } = req.body;
  if(!client_name) return res.status(400).json({ error: 'Client name required' });

  // Look up the client user by email so portal access (requireProjectAccess) works
  let userId = null;
  if(email){
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .eq('role', 'client')
      .maybeSingle();
    userId = userRow ? userRow.id : null;
  }

  // Dedup: if this client (by email) is already linked to the project, update instead of inserting
  let existing = null;
  if(email){
    const { data: existRow } = await supabaseAdmin
      .from('project_clients')
      .select('id')
      .eq('project_id', req.params.id)
      .eq('email', email)
      .maybeSingle();
    existing = existRow;
  }

  if(existing){
    const { data, error } = await supabaseAdmin
      .from('project_clients')
      .update({ client_name, phone, user_id: userId })
      .eq('id', existing.id)
      .select()
      .single();
    if(error) return res.status(400).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabaseAdmin
    .from('project_clients')
    .insert({ project_id: req.params.id, client_name, email, phone, user_id: userId })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
