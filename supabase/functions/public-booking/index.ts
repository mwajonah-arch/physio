import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Public booking for patients. No login: it never returns anyone's name,
// phone or address, only the services on offer and which times are free.
// Bookings arrive as status "requested" for the clinic to confirm.

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// ---- Clinic rules: change these to suit ----
const OPEN_TIME = '08:00'        // first visit may start at this time (Kenya time)
const CLOSE_TIME = '17:00'       // a visit must finish by this time
const OPEN_DAYS = [1, 2, 3, 4, 5, 6] // 0 = Sunday ... 6 = Saturday
const STEP_MIN = 30              // start times offered every 30 minutes
const LEAD_HOURS = 3             // earliest booking is this long from now
const MAX_DAYS_AHEAD = 30
const BUFFER_MIN = 30            // travel gap kept free either side of a visit
const MAX_PENDING_PER_PHONE = 3
const MAX_REQUESTS_PER_HOUR = 20 // across everyone, to blunt spam

const VISIT_TYPES = ['home', 'hospital', 'shop']
const EAT = '+03:00' // Kenya has no daylight saving

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const str = (v: unknown, max = 300) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
const newId = () => `apt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

const todayEat = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00${EAT}`) + n * 86400000 + 3 * 3600000).toISOString().slice(0, 10)
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const pad = (n: number) => String(n).padStart(2, '0')
const startMs = (date: string, minutes: number) => Date.parse(`${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00${EAT}`)

// 0712 345 678, 712345678, +254712345678 -> "0712345678", or null.
function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('254')) d = d.slice(3)
  else if (d.startsWith('0')) d = d.slice(1)
  return /^[17]\d{8}$/.test(d) ? '0' + d : null
}

async function nearVisits(date: string) {
  const lo = new Date(startMs(date, 0) - 24 * 3600000).toISOString()
  const hi = new Date(startMs(date, 24 * 60) + 24 * 3600000).toISOString()
  const { data, error } = await supabase.from('appointments')
    .select('start_at, duration_min').gte('start_at', lo).lte('start_at', hi).not('status', 'in', '(cancelled,no_show)')
  if (error) throw error
  return data || []
}

function isFree(start: number, durationMin: number, near: { start_at: string; duration_min: number }[]) {
  const end = start + durationMin * 60000
  const buf = BUFFER_MIN * 60000
  return !near.some((o) => {
    const os = new Date(o.start_at).getTime()
    return start < os + o.duration_min * 60000 + buf && end + buf > os
  })
}

// Returns { error } for a bad date, otherwise the free "HH:MM" start times.
async function freeSlots(date: string, durationMin: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Choose a valid date.' }
  const today = todayEat()
  if (date < today || date > addDays(today, MAX_DAYS_AHEAD)) return { error: `Choose a date in the next ${MAX_DAYS_AHEAD} days.` }
  const dow = new Date(`${date}T12:00:00${EAT}`).getUTCDay()
  if (!OPEN_DAYS.includes(dow)) return { slots: [] as string[], closed: true }
  const near = await nearVisits(date)
  const earliest = Date.now() + LEAD_HOURS * 3600000
  const slots: string[] = []
  for (let m = toMin(OPEN_TIME); m + durationMin <= toMin(CLOSE_TIME); m += STEP_MIN) {
    const s = startMs(date, m)
    if (s >= earliest && isFree(s, durationMin, near)) slots.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  }
  return { slots, closed: false }
}

async function loadService(id: unknown) {
  if (!id) return null
  const { data } = await supabase.from('services').select('id, name, price, duration_min, active').eq('id', String(id)).maybeSingle()
  return data && data.active !== false ? data : null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const b = await req.json()

    if (b.action === 'info') {
      const [sv, st] = await Promise.all([
        supabase.from('services').select('id, name, price, duration_min').eq('active', true).order('name'),
        supabase.from('kv_store').select('value').eq('key', 'settings').maybeSingle(),
      ])
      if (sv.error) { console.error(sv.error); return json({ error: 'Booking is unavailable right now.' }, 500) }
      const settings = (st.data && st.data.value) || {}
      return json({
        business: settings.pharmacyName || 'Physio Care',
        phone: settings.phone || '',
        currency: settings.currency || 'KSh',
        services: sv.data || [],
        openTime: OPEN_TIME, closeTime: CLOSE_TIME, openDays: OPEN_DAYS,
        maxDaysAhead: MAX_DAYS_AHEAD, leadHours: LEAD_HOURS,
      })
    }

    if (b.action === 'slots') {
      const svc = await loadService(b.serviceId)
      if (!svc) return json({ error: 'Choose a service.' }, 400)
      const r = await freeSlots(String(b.date || ''), svc.duration_min)
      if ('error' in r) return json({ error: r.error }, 400)
      return json(r)
    }

    if (b.action === 'request') {
      // Hidden field real people never fill in. Pretend it worked.
      if (b.website) return json({ ok: true, reference: 'XXXXXX' })

      const svc = await loadService(b.serviceId)
      if (!svc) return json({ error: 'Choose a service.' }, 400)
      const name = str(b.name, 120)
      if (name.length < 2) return json({ error: 'Please enter your name.' }, 400)
      const phone = normalizePhone(b.phone)
      if (!phone) return json({ error: 'Enter a Kenyan mobile number, like 0712 345 678.' }, 400)
      const visitType = VISIT_TYPES.includes(b.visitType) ? b.visitType : null
      if (!visitType) return json({ error: 'Choose where the visit should happen.' }, 400)
      const location = str(b.location)
      if (visitType !== 'shop' && location.length < 3) {
        return json({ error: visitType === 'home' ? 'Please give your address or a landmark.' : 'Please give the hospital and ward.' }, 400)
      }
      const time = String(b.time || '')
      if (!/^\d{2}:\d{2}$/.test(time)) return json({ error: 'Choose a time.' }, 400)

      // The time must still be on the free list (also enforces opening hours and lead time).
      const r = await freeSlots(String(b.date || ''), svc.duration_min)
      if ('error' in r) return json({ error: r.error }, 400)
      if (!r.slots.includes(time)) return json({ error: 'Sorry, that time was just taken. Please pick another.', taken: true }, 409)

      // Spam limits.
      const hourAgo = new Date(Date.now() - 3600000).toISOString()
      const recent = await supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('created_by', 'public').gte('updated_at', hourAgo)
      if ((recent.count ?? 0) >= MAX_REQUESTS_PER_HOUR) return json({ error: 'We are getting a lot of requests. Please try again later, or call us.' }, 429)
      const pending = await supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('created_by', 'public').eq('phone', phone).eq('status', 'requested')
      if ((pending.count ?? 0) >= MAX_PENDING_PER_PHONE) return json({ error: 'You already have requests waiting for confirmation. We will be in touch soon, or please call us.' }, 429)

      const id = newId()
      const row = {
        id,
        customer_id: null,
        customer_name: name,
        phone,
        service_id: svc.id,
        service_name: svc.name,
        price: Number(svc.price) || 0,
        start_at: new Date(startMs(String(b.date), toMin(time))).toISOString(),
        duration_min: svc.duration_min,
        visit_type: visitType,
        location: visitType === 'shop' ? '' : location,
        travel_fee: 0,
        status: 'requested',
        notes: str(b.notes, 300),
        created_by: 'public',
        updated_at: new Date().toISOString(),
      }
      const { error } = await supabase.from('appointments').insert(row)
      if (error) { console.error('public-booking insert', error); return json({ error: 'Could not send your request. Please try again or call us.' }, 500) }
      return json({ ok: true, reference: id.slice(-6).toUpperCase() })
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (e) {
    console.error('public-booking error', e)
    return json({ error: 'Something went wrong. Please try again.' }, 500)
  }
})
