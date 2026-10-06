import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readCredential } from './credentials.js'
import { createTransport } from './transport.js'

function catalog(value) { for (const list of [value?.models, value?.data, value?.items, value?.catalog, value]) if (Array.isArray(list)) return list; return [] }
function codexEntries(value) {
  return catalog(value).filter((v) => typeof (v.slug ?? v.id) === 'string').map((v) => ({ source: 'codex', provider: 'codex-subscription', id: v.slug ?? v.id, name: v.display_name ?? v.name ?? v.slug ?? v.id }))
}
export async function listReviewModels(settings, llm, refresh, signal) {
  let entries = [{ source: 'codex', provider: 'codex-subscription', id: 'codex-auto-review', name: 'Codex Auto Review (Guardian)' }], codexStatus = 'default-only'
  try { const cached = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8')); entries.push(...codexEntries(cached)); codexStatus = 'cached' } catch {}
  if (refresh) {
    const credential = readCredential({ credentialFile: settings.credentialFile })
    if (credential.ok) try {
      const transport = createTransport({ mode: settings.transport, proxy: settings.proxy, timeoutMs: settings.timeoutMs })
      const res = await transport.request({ url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.153.4', method: 'GET', headers: { authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId, originator: 'codex_cli_rs', accept: 'application/json' }, signal })
      if (res.status !== 200) throw new Error('catalog-failed')
      entries = [entries[0], ...codexEntries(JSON.parse(res.body))]; codexStatus = 'live'
    } catch { codexStatus = 'refresh-unavailable' }
    else codexStatus = 'credential-unavailable'
  }
  let dshStatus = 'available', providers = []
  try {
    providers = llm.listProviders().map((v) => ({ id: v.id, name: v.name ?? v.id }))
    for (const provider of providers) {
      if (signal?.aborted) throw new Error('aborted')
      try { const models = await llm.listModels(provider.id); entries.push(...models.map((v) => ({ source: 'dsh', provider: provider.id, id: v.id, name: v.name ?? v.id }))) } catch { dshStatus = 'partial' }
    }
  } catch { dshStatus = 'unavailable' }
  const seen = new Set()
  return { models: entries.filter((v) => { const key = `${v.source}\0${v.provider}\0${v.id}`; if (seen.has(key)) return false; seen.add(key); return true }), providers, codexStatus, dshStatus }
}
