import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifySession, CORS_HEADERS, jsonResponse } from './session.ts'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SESSION_SECRET = Deno.env.get('SESSION_SECRET')!

// Saves sales and the two later changes to them (void, settle).
// Inserting the same sale id twice is ignored, so an offline retry is safe.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const b = await req.json()
    const session = await verifySession(b.token, SESSION_SECRET)
    if (!session) return jsonResponse({ error: 'Your session has expired. Please log in again.' }, 401)

    if (b.action === 'insert') {
      const sale = b.sale
      if (!sale || !sale.id) return jsonResponse({ error: 'Missing sale details.' }, 400)
      const ts = new Date(sale.timestamp)
      const { error } = await supabase.from('sales').upsert(
        { id: String(sale.id), data: sale, created_at: isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString() },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      if (error) {
        console.error('record-sale insert error', error)
        return jsonResponse({ error: 'Could not save the sale.' }, 500)
      }
      return jsonResponse({ ok: true })
    }

    if (b.action === 'void' || b.action === 'settle') {
      if (!b.id) return jsonResponse({ error: 'Missing sale id.' }, 400)
      const now = new Date().toISOString()
      const patch = b.action === 'void'
        ? { voided: true, voidReason: b.reason || '', voidedAt: now, voidedBy: b.voidedBy ?? null }
        : {
            settled: true, settledAt: now, settledBy: b.settledBy ?? null, settledMethod: b.method || 'cash',
            ...(b.mpesaReceipt ? { mpesaReceipt: b.mpesaReceipt } : {}),
            ...(b.paymentRef ? { paymentRef: b.paymentRef } : {}),
            ...(b.paymentTxnId ? { paymentTxnId: b.paymentTxnId } : {}),
          }
      const { data, error } = await supabase.rpc('patch_sale', { p_id: String(b.id), p_patch: patch })
      if (error) {
        console.error('record-sale patch error', error)
        return jsonResponse({ error: 'Could not update the sale.' }, 500)
      }
      if (!data) return jsonResponse({ error: 'Sale not found.' }, 404)
      return jsonResponse({ ok: true })
    }

    return jsonResponse({ error: 'Unknown action.' }, 400)
  } catch (e) {
    console.error('record-sale error', e)
    return jsonResponse({ error: 'Could not reach the server.' }, 500)
  }
})
