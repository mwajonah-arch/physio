import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifySession, CORS_HEADERS, jsonResponse } from './session.ts'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SESSION_SECRET = Deno.env.get('SESSION_SECRET')!

const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const str = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max)
const num = (v: unknown) => Math.max(0, Number(v) || 0)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const kenyaToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)
const dayMs = 86400000
const addDays = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * dayMs).toISOString().slice(0, 10)
const diffDays = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / dayMs)
const digits = (p: string) => String(p || '').replace(/\D/g, '').slice(-9)

// Whole weeks at the weekly rate (when there is one), leftover days at the daily rate but never more than a week.
function rentalFee(days: number, daily: number, weekly: number | null) {
  if (!weekly || weekly <= 0) return days * daily
  const weeks = Math.floor(days / 7)
  const rest = days % 7
  return weeks * weekly + Math.min(rest * daily, weekly)
}

// The ids among these sales that have been voided.
async function voidedSales(ids: string[]) {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('sales').select('id, data').in('id', ids.slice(i, i + 100))
    if (error || !data) { console.error('sale check error', error); continue }
    data.forEach((r) => { if (r.data && r.data.voided) out.add(r.id) })
  }
  return out
}

async function ensureCustomer(id: unknown, name: string, phone: string) {
  if (id) return String(id)
  if (phone) {
    const { data } = await supabase.from('customers').select('id, phone').ilike('phone', '%' + digits(phone))
    const hit = (data || []).find((c) => digits(c.phone) === digits(phone))
    if (hit) return hit.id as string
  }
  const row = { id: newId('cus'), name, phone, address: '', notes: '' }
  const { error } = await supabase.from('customers').insert(row)
  if (error) { console.error('customer create error', error); return null }
  return row.id
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const b = await req.json()
    const session = await verifySession(b.token, SESSION_SECRET)
    if (!session) return jsonResponse({ error: 'Your session has expired. Please log in again.' }, 401)
    const isAdmin = session.role === 'admin'
    const who = str((session as any).name || (session as any).sub || session.role, 80)

    if (b.action === 'list') {
      const [it, rn, tp, pk] = await Promise.all([
        supabase.from('rental_items').select('*').order('name'),
        supabase.from('rentals').select('*').order('created_at', { ascending: false }).limit(500),
        supabase.from('package_templates').select('*').order('name'),
        supabase.from('customer_packages').select('*').order('created_at', { ascending: false }).limit(1000),
      ])
      if (it.error || rn.error || tp.error || pk.error) {
        console.error('list error', it.error || rn.error || tp.error || pk.error)
        return jsonResponse({ error: 'Could not load rentals and packages. Has the setup SQL been run?' }, 500)
      }
      const rentals = rn.data || []
      const packages = pk.data || []

      // A voided sale takes the money back: the rental fee becomes unpaid again,
      // and a voided package can no longer be used.
      const rSales = rentals.filter((r) => r.sale_id).map((r) => r.sale_id)
      const pSales = packages.filter((p) => p.sale_id && p.status === 'active').map((p) => p.sale_id)
      const voided = await voidedSales(Array.from(new Set([...rSales, ...pSales])))
      const relR = rentals.filter((r) => r.sale_id && voided.has(r.sale_id))
      if (relR.length) {
        const { error } = await supabase.from('rentals').update({ sale_id: null }).in('id', relR.map((r) => r.id))
        if (!error) relR.forEach((r) => { r.sale_id = null })
      }
      const relP = packages.filter((p) => p.status === 'active' && p.sale_id && voided.has(p.sale_id))
      if (relP.length) {
        const { error } = await supabase.from('customer_packages').update({ status: 'voided' }).in('id', relP.map((p) => p.id))
        if (!error) relP.forEach((p) => { p.status = 'voided' })
      }

      const ids = packages.map((p) => p.id)
      let uses: any[] = []
      for (let i = 0; i < ids.length; i += 100) {
        const { data } = await supabase.from('package_uses').select('*').in('package_id', ids.slice(i, i + 100)).order('used_at', { ascending: false })
        uses = uses.concat(data || [])
      }
      const withUse = packages.map((p) => {
        const u = uses.filter((x) => x.package_id === p.id)
        return { ...p, sessions_used: u.length, uses: u }
      })
      const out: Record<string, number> = {}
      rentals.filter((r) => r.status === 'out').forEach((r) => { out[r.item_id] = (out[r.item_id] || 0) + r.qty })
      const items = (it.data || []).map((i) => ({ ...i, out: out[i.id] || 0 }))
      return jsonResponse({ items, rentals, templates: tp.data || [], packages: withUse, today: kenyaToday() })
    }

    if (b.action === 'save-item') {
      if (!isAdmin) return jsonResponse({ error: 'Only an admin can change the rentals list.' }, 403)
      const i = b.item || {}
      const name = str(i.name, 120)
      if (!name) return jsonResponse({ error: 'Enter the item name.' }, 400)
      const weekly = i.weeklyRate === '' || i.weeklyRate == null ? null : num(i.weeklyRate)
      const row = {
        id: i.id || newId('ri'), name,
        daily_rate: num(i.dailyRate), weekly_rate: weekly && weekly > 0 ? weekly : null,
        deposit: num(i.deposit), quantity: Math.max(1, Math.round(Number(i.quantity) || 1)),
        active: i.active !== false, notes: str(i.notes, 500),
      }
      if (row.daily_rate <= 0) return jsonResponse({ error: 'Enter a daily rate.' }, 400)
      const { error } = await supabase.from('rental_items').upsert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not save the item.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'save-template') {
      if (!isAdmin) return jsonResponse({ error: 'Only an admin can change packages.' }, 403)
      const t = b.template || {}
      const name = str(t.name, 120)
      const sessions = Math.round(Number(t.sessions) || 0)
      if (!name) return jsonResponse({ error: 'Enter the package name.' }, 400)
      if (sessions < 1 || sessions > 200) return jsonResponse({ error: 'Enter how many sessions it includes.' }, 400)
      const row = { id: t.id || newId('pt'), name, sessions, price: num(t.price), active: t.active !== false }
      const { error } = await supabase.from('package_templates').upsert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not save the package.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'rent-out') {
      const r = b.rental || {}
      const name = str(r.customerName, 120)
      const phone = str(r.phone, 30)
      if (!name) return jsonResponse({ error: 'Enter the customer’s name.' }, 400)
      if (!phone) return jsonResponse({ error: 'Enter a phone number so you can reach the customer.' }, 400)
      const qty = Math.max(1, Math.round(Number(r.qty) || 1))
      const days = Math.round(Number(r.days) || 0)
      if (days < 1 || days > 365) return jsonResponse({ error: 'Enter how many days (1 to 365).' }, 400)
      const start = DATE_RE.test(String(r.startDate)) ? String(r.startDate) : kenyaToday()
      const { data: item, error: ie } = await supabase.from('rental_items').select('*').eq('id', r.itemId).maybeSingle()
      if (ie || !item) return jsonResponse({ error: 'That item is no longer on the rentals list.' }, 404)
      if (!item.active) return jsonResponse({ error: 'That item is hidden from rentals.' }, 400)
      const { data: outRows, error: oe } = await supabase.from('rentals').select('qty').eq('item_id', item.id).eq('status', 'out')
      if (oe) { console.error(oe); return jsonResponse({ error: 'Could not check availability.' }, 500) }
      const out = (outRows || []).reduce((s, x) => s + x.qty, 0)
      const free = item.quantity - out
      if (qty > free) return jsonResponse({ error: free <= 0 ? `${item.name} is all out on hire.` : `Only ${free} of ${item.name} ${free === 1 ? 'is' : 'are'} available.` }, 409)
      const customerId = await ensureCustomer(r.customerId, name, phone)
      const row = {
        id: newId('rt'), item_id: item.id, item_name: item.name,
        customer_id: customerId, customer_name: name, phone, qty,
        start_date: start, due_date: addDays(start, days), days,
        fee: rentalFee(days, Number(item.daily_rate), item.weekly_rate == null ? null : Number(item.weekly_rate)) * qty,
        deposit_held: Number(item.deposit) * qty,
        status: 'out', notes: str(r.notes, 500), created_by: who,
      }
      const { error } = await supabase.from('rentals').insert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not record the rental.' }, 500) }
      return jsonResponse({ ok: true, rental: row })
    }

    if (b.action === 'link-rental-sale') {
      const { error } = await supabase.from('rentals').update({ sale_id: str(b.saleId, 80) }).eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not link the payment.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'cancel-rental') {
      const { data: r } = await supabase.from('rentals').select('*').eq('id', b.id).maybeSingle()
      if (!r) return jsonResponse({ error: 'Rental not found.' }, 404)
      if (r.status !== 'out' || r.sale_id) return jsonResponse({ error: 'Only an unpaid rental that is still out can be cancelled. Void its sale first if it was paid.' }, 400)
      const { error } = await supabase.from('rentals').delete().eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not cancel the rental.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'return-rental') {
      const { data: r } = await supabase.from('rentals').select('*').eq('id', b.id).maybeSingle()
      if (!r) return jsonResponse({ error: 'Rental not found.' }, 404)
      if (r.status !== 'out') return jsonResponse({ error: 'This item has already been returned.' }, 409)
      const { data: item } = await supabase.from('rental_items').select('daily_rate').eq('id', r.item_id).maybeSingle()
      const daily = item ? Number(item.daily_rate) : (Number(r.fee) / Math.max(1, r.days) / Math.max(1, r.qty))
      const today = kenyaToday()
      const lateDays = Math.max(0, diffDays(r.due_date, today))
      const lateFee = lateDays * daily * r.qty
      const held = Number(r.deposit_held)
      const damage = Math.min(num(b.damage), held)
      const retained = Math.min(held, lateFee + damage)
      const owed = Math.max(0, lateFee + damage - held)
      const row = {
        status: 'returned', returned_at: new Date().toISOString(),
        late_fee: lateFee, damage_kept: damage,
        deposit_refunded: held - retained, owed,
        notes: [r.notes, str(b.note, 300)].filter(Boolean).join(' · '),
      }
      const { error } = await supabase.from('rentals').update(row).eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not record the return.' }, 500) }
      return jsonResponse({ ok: true, ...row, lateDays })
    }

    if (b.action === 'sell-package') {
      const p = b.package || {}
      const name = str(p.customerName, 120)
      const phone = str(p.phone, 30)
      if (!name) return jsonResponse({ error: 'Enter the customer’s name.' }, 400)
      const { data: t } = await supabase.from('package_templates').select('*').eq('id', p.templateId).maybeSingle()
      if (!t || !t.active) return jsonResponse({ error: 'That package is not on offer.' }, 404)
      const customerId = await ensureCustomer(p.customerId, name, phone)
      const row = {
        id: newId('pk'), customer_id: customerId, customer_name: name, phone,
        template_id: t.id, name: t.name, sessions_total: t.sessions, price: Number(t.price),
        status: 'active', created_by: who,
      }
      const { error } = await supabase.from('customer_packages').insert(row)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not record the package.' }, 500) }
      return jsonResponse({ ok: true, package: row })
    }

    if (b.action === 'link-package-sale') {
      const { error } = await supabase.from('customer_packages').update({ sale_id: str(b.saleId, 80) }).eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not link the payment.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'cancel-package') {
      const { data: p } = await supabase.from('customer_packages').select('*').eq('id', b.id).maybeSingle()
      if (!p) return jsonResponse({ error: 'Package not found.' }, 404)
      if (p.sale_id) return jsonResponse({ error: 'This package has been paid for. Void its sale first.' }, 400)
      const { count } = await supabase.from('package_uses').select('id', { count: 'exact', head: true }).eq('package_id', p.id)
      if (count) return jsonResponse({ error: 'Sessions have already been used from this package.' }, 400)
      const { error } = await supabase.from('customer_packages').delete().eq('id', b.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not cancel the package.' }, 500) }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'use-package-session') {
      const { data: p } = await supabase.from('customer_packages').select('*').eq('id', b.packageId).maybeSingle()
      if (!p || p.status !== 'active') return jsonResponse({ error: 'That package can’t be used.' }, 404)
      if (!p.sale_id) return jsonResponse({ error: 'This package hasn’t been paid for yet. Take payment first.' }, 400)
      const { data: a } = await supabase.from('appointments').select('id, status, sale_id').eq('id', b.appointmentId).maybeSingle()
      if (!a) return jsonResponse({ error: 'Visit not found.' }, 404)
      if (a.status !== 'confirmed' || a.sale_id) return jsonResponse({ error: 'Only a confirmed, uncharged visit can use a package session.' }, 409)
      const useRow = { id: newId('pu'), package_id: p.id, appointment_id: a.id, created_by: who }
      const { error: ue } = await supabase.from('package_uses').insert(useRow)
      if (ue) {
        console.error(ue)
        return jsonResponse({ error: 'This visit already used a package session.' }, 409)
      }
      const { count } = await supabase.from('package_uses').select('id', { count: 'exact', head: true }).eq('package_id', p.id)
      if ((count || 0) > p.sessions_total) {
        await supabase.from('package_uses').delete().eq('id', useRow.id)
        return jsonResponse({ error: 'No sessions left on this package.' }, 409)
      }
      const { error: ae } = await supabase.from('appointments').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', a.id)
      if (ae) {
        console.error(ae)
        await supabase.from('package_uses').delete().eq('id', useRow.id)
        return jsonResponse({ error: 'Could not complete the visit.' }, 500)
      }
      return jsonResponse({ ok: true, left: p.sessions_total - (count || 0) })
    }

    if (b.action === 'undo-package-use') {
      if (!isAdmin) return jsonResponse({ error: 'Only an admin can undo a session.' }, 403)
      const { data: u } = await supabase.from('package_uses').select('*').eq('id', b.useId).maybeSingle()
      if (!u) return jsonResponse({ error: 'Session record not found.' }, 404)
      const { error } = await supabase.from('package_uses').delete().eq('id', u.id)
      if (error) { console.error(error); return jsonResponse({ error: 'Could not undo.' }, 500) }
      await supabase.from('appointments').update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', u.appointment_id).is('sale_id', null)
      return jsonResponse({ ok: true })
    }

    return jsonResponse({ error: 'Unknown action.' }, 400)
  } catch (e) {
    console.error('manage-rentals error', e)
    return jsonResponse({ error: 'Something went wrong. Please try again.' }, 500)
  }
})
