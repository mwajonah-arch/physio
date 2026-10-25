import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifySession, CORS_HEADERS, jsonResponse } from './session.ts'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SESSION_SECRET = Deno.env.get('SESSION_SECRET')!

// Writes one activity-log row. The staff member comes from the signed
// session, never from what the browser says, so entries can't be faked.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const b = await req.json()
    const session = await verifySession(b.token, SESSION_SECRET)
    if (!session) return jsonResponse({ error: 'Your session has expired. Please log in again.' }, 401)
    if (!b.id || !b.action) return jsonResponse({ error: 'Missing log details.' }, 400)

    let staffName = 'Unknown'
    const { data: kv } = await supabase.from('kv_store').select('value').eq('key', 'staff').maybeSingle()
    const person = Array.isArray(kv?.value) ? kv.value.find((s: any) => s.id === session.sub) : null
    if (person?.name) staffName = person.name

    const { error } = await supabase.from('activity_log').upsert({
      id: String(b.id),
      staff_id: session.sub,
      staff_name: staffName,
      action: String(b.action),
      subject: b.subject || '',
      sku: b.sku || '',
      detail: b.detail || '',
      before: b.before ?? null,
      after: b.after ?? null,
      ref_id: b.refId ?? null,
      amount: b.amount ?? null,
    }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) {
      console.error('log-activity error', error)
      return jsonResponse({ error: 'Could not save the log entry.' }, 500)
    }
    return jsonResponse({ ok: true })
  } catch (e) {
    console.error('log-activity error', e)
    return jsonResponse({ error: 'Could not reach the server.' }, 500)
  }
})
