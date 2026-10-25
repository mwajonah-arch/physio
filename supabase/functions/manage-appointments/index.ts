import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifySession, CORS_HEADERS, jsonResponse } from './session.ts'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SESSION_SECRET = Deno.env.get('SESSION_SECRET')!

const VISIT_TYPES = ['home', 'hospital', 'shop']
const STATUSES = ['requested', 'confirmed', 'completed', 'cancelled', 'no_show']
const BUFFER_MIN = 30 // gap kept free before and after a visit, for travel
const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const str = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max)

// The first booked visit that overlaps this slot (with the travel buffer), or null.
async function findClash(startIso: string, durationMin: number, excludeId: string) {
  const start = new Date(startIso).getTime()
  const end = start + durationMin * 60000
  const lo = new Date(start - 24 * 3600000).toISOString()
  const hi = new Date(end + 24 * 3600000).toISOString()
  const { data, error } = await supabase.from('appointments')
    .select('id, customer_name, start_at, duration_min, status')
    .gte('start_at', lo).lte('start_at', hi).not('status', 'in', '(cancelled,no_show)').neq('id', excludeId)
  if (error) throw error
  const buf = BUFFER_MIN * 60000
  return (data || []).find((o) => {
    const os = new Date(o.start_at).getTime()
    return start < os + o.duration_min * 60000 + buf && end + buf > os
  }) || null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const b = await req.json()
    const session = await verifySession(b.token, SESSION_SECRET)
    if (!session) return jsonResponse({ error: 'Your session has expired. Please log in again.' }, 401)
    const isAdmin = session.role === 'admin'

    if (b.action === 'list') {
      let appts = supabase.from('appointments').select('*').order('start_at', { ascending: false }).limit(1000)
      if (b.from) appts = appts.gte('start_at', b.from)
      if (b.to) appts = appts.lte('start_at', b.to)
      const [c, s, a] = await Promise.all([
        supabase.from('customers').select('*').order('name').limit(5000),
        supabase.from('services').select('*').order('name'),
        appts,
      ])
      if (c.error || s.error || a.error) {
        console.error('list error', c.error || s.error || a.error)
        return jsonResponse({ error: 'Could not load appointments.' }, 500)
      }
      // A visit that was charged and whose sale has since been voided goes back to
      // "confirmed" so it can be charged again. Checked here, so it also works for
      // voids made on another till or while offline.
      const appointments = a.data || []
      const linked = appointments.filter((x) => x.sale_id && x.status === 'completed')
      for (let i = 0; i < linked.length; i += 100) {
        const chunk = linked.slice(i, i + 100)
        const { data: sl, error: slErr } = await supabase.from('sales').select('id, data').in('id', chunk.map((x) => x.sale_id))
        if (slErr || !sl) { console.error('sale check error', slErr); break }
        const voided = new Set(sl.filter((r) => r.data && r.data.voided).map((r) => r.id))
        const release = chunk.filter((x) => voided.has(x.sale_id))
        if (release.length === 0) continue
        const { error: upErr } = await supabase.from('appointments')
          .update({ status: 'confirmed', sale_id: null, updated_at: new Date().toISOString() })
          .in('id', release.map((x) => x.id))
        if (upErr) { console.error('release error', upErr); continue }
        for (const x of release) { x.status = 'confirmed'; x.sale_id = null }
      }
      return jsonResponse({ customers: c.data, services: s.data, appointments })
    }

    if (b.action === 'list-services') {
      const { data, error } = await supabase.from('services').select('*').eq('active', true).order('name')
      if (error) { console.error(error); return jsonResponse({ error: 'Could not load services.' }, 500) }
      return jsonResponse({ services: data })
    }

    if (b.action === 'save-customer') {
      const c = b.customer || {}
      const name = str(c.name, 120)
      if (!name) return jsonResponse({ error: 'Enter the customer’s name.' }, 400)
      const row = { id: c.id || newId('cus'), name, phone: str(c.phone, 30), address: str(c.address), notes: str(c.notes, 1000) }
      const { error } = await supabase.from('customers').upsert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not save the customer.' }, 500) }
      return jsonResponse({ ok: true, customer: row })
    }

    if (b.action === 'save-service') {
      if (!isAdmin) return jsonResponse({ error: 'Only an admin can change services.' }, 403)
      const s = b.service || {}
      const name = str(s.name, 120)
      if (!name) return jsonResponse({ error: 'Enter the service name.' }, 400)
      const row = {
        id: s.id || newId('sv'), name,
        price: Math.max(0, Number(s.price) || 0),
        duration_min: Math.max(5, Math.round(Number(s.durationMin) || 60)),
        active: s.active !== false,
      }
      const { error } = await supabase.from('services').upsert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not save the service.' }, 500) }
      return jsonResponse({ ok: true, service: row })
    }

    if (b.action === 'save-appointment') {
      const a = b.appointment || {}
      const start = new Date(a.startAt)
      if (isNaN(start.getTime())) return jsonResponse({ error: 'Choose a valid date and time.' }, 400)
      const customerName = str(a.customerName, 120)
      if (!customerName) return jsonResponse({ error: 'Choose or enter the customer.' }, 400)
      const visitType = VISIT_TYPES.includes(a.visitType) ? a.visitType : 'home'
      const status = STATUSES.includes(a.status) ? a.status : 'confirmed'
      const durationMin = Math.max(5, Math.round(Number(a.durationMin) || 60))
      const id = a.id || newId('apt')

      // Overlap check, with a travel buffer either side. `force: true` skips it.
      if (!b.force && !['cancelled', 'no_show'].includes(status)) {
        const end = new Date(start.getTime() + durationMin * 60000)
        const lo = new Date(start.getTime() - 24 * 3600000).toISOString()
        const hi = new Date(end.getTime() + 24 * 3600000).toISOString()
        const { data: near, error: nearErr } = await supabase.from('appointments')
          .select('id, customer_name, start_at, duration_min, status')
          .gte('start_at', lo).lte('start_at', hi).not('status', 'in', '(cancelled,no_show)').neq('id', id)
        if (nearErr) { console.error(nearErr); return jsonResponse({ error: 'Could not check the diary.' }, 500) }
        const buf = BUFFER_MIN * 60000
        const clash = (near || []).find((o) => {
          const os = new Date(o.start_at).getTime()
          const oe = os + o.duration_min * 60000
          return start.getTime() < oe + buf && end.getTime() + buf > os
        })
        if (clash) {
          return jsonResponse({ error: `This overlaps ${clash.customer_name}’s visit (or is too close to travel between them).`, conflict: clash }, 409)
        }
      }

      const row = {
        id,
        customer_id: a.customerId || null,
        customer_name: customerName,
        phone: str(a.phone, 30),
        service_id: a.serviceId || null,
        service_name: str(a.serviceName, 120),
        price: Math.max(0, Number(a.price) || 0),
        start_at: start.toISOString(),
        duration_min: durationMin,
        visit_type: visitType,
        location: str(a.location),
        travel_fee: Math.max(0, Number(a.travelFee) || 0),
        status,
        notes: str(a.notes, 1000),
        created_by: session.sub,
        updated_at: new Date().toISOString(),
      }
      const { error } = await supabase.from('appointments').upsert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not save the appointment.' }, 500) }
      return jsonResponse({ ok: true, appointment: row })
    }

    if (b.action === 'set-status') {
      if (!b.id || !STATUSES.includes(b.status)) return jsonResponse({ error: 'Invalid status.' }, 400)
      // Reopening a cancelled or no-show visit: make sure the slot is still free.
      if (!b.force && !['cancelled', 'no_show'].includes(b.status)) {
        const { data: cur } = await supabase.from('appointments').select('status, start_at, duration_min').eq('id', b.id).maybeSingle()
        if (cur && ['cancelled', 'no_show'].includes(cur.status)) {
          const clash = await findClash(cur.start_at, cur.duration_min, b.id)
          if (clash) return jsonResponse({ error: `This time now overlaps ${clash.customer_name}’s visit (or is too close to travel between them).`, conflict: clash }, 409)
        }
      }
      const patch: Record<string, unknown> = { status: b.status, updated_at: new Date().toISOString() }
      if (b.saleId) {
        // A visit can only be charged once.
        const { data: cur } = await supabase.from('appointments').select('sale_id').eq('id', b.id).maybeSingle()
        if (cur && cur.sale_id && cur.sale_id !== String(b.saleId)) return jsonResponse({ error: 'This visit has already been charged.' }, 409)
        patch.sale_id = String(b.saleId)
      }
      // Confirming an online request: make sure the person is in the customer list.
      if (b.status === 'confirmed') {
        const { data: row } = await supabase.from('appointments').select('customer_id, customer_name, phone, visit_type, location').eq('id', b.id).maybeSingle()
        if (row && !row.customer_id) {
          let cid: string | null = null
          if (row.phone) {
            const { data: ex } = await supabase.from('customers').select('id').eq('phone', row.phone).limit(1)
            cid = ex && ex[0] ? ex[0].id : null
          }
          if (!cid) {
            cid = newId('cus')
            const { error: cErr } = await supabase.from('customers').insert({ id: cid, name: row.customer_name, phone: row.phone || '', address: row.visit_type === 'home' ? row.location || '' : '', notes: '' })
            if (cErr) { console.error(cErr); cid = null }
          }
          if (cid) patch.customer_id = cid
        }
      }
      const { error } = await supabase.from('appointments').update(patch).eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not update the appointment.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'delete-appointment') {
      if (!isAdmin) return jsonResponse({ error: 'Only an admin can delete appointments. Cancel it instead.' }, 403)
      const { error } = await supabase.from('appointments').delete().eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not delete.' }, 500) }
      return jsonResponse({ ok: true })
    }

    return jsonResponse({ error: 'Unknown action.' }, 400)
  } catch (e) {
    console.error('manage-appointments error', e)
    return jsonResponse({ error: 'Could not reach the server.' }, 500)
  }
})
