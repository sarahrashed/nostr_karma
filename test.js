// v1 client with per-post upvote/downvote, one vote per user per post,
// buffered feed, SVG icons, and score display.

import {
  generatePrivateKey,
  getPublicKey,
  finishEvent,
  relayInit,
  nip19
} from 'nostr-tools'

// ---- Custom kinds for moderation/karma ----
const KIND_NOTE       = 1
const KIND_KARMA_VOTE = 30010  // tags: ['p', author], ['e', eventId], ['v', +1|-1|0]

// Light PoW miner (optional). Uses hex prefix zeros; bits≈nibbles*4.
function mineAndFinish(unsigned, sk, powBits = 8, maxIters = 20000) {
  const nibbles = Math.max(0, Math.floor(powBits / 4))
  const targetPrefix = '0'.repeat(nibbles)
  let nonce = 0
  while (nonce < maxIters) {
    const u = {
      ...unsigned,
      tags: [...(unsigned.tags || []), ['nonce', String(nonce)]]
    }
    const ev = finishEvent(u, sk)
    if (!nibbles || ev.id.startsWith(targetPrefix)) return ev
    nonce++
  }
  return finishEvent(unsigned, sk)
}

class NostrClient {
  constructor() {
    // keys
    this.privateKey = null
    this.publicKey  = null

    // relays
    this.relays = []
    this.connectedRelays = new Set()

    // feed/state
    this.seenIds = new Set()
    this.buffer = []                // holds incoming events until we reveal them
    this.bufferFlushMs = 45000      // only used if you call startAutoFlush()
    this.bufferTimer = null

    // local vote cache: eventId -> -1, 0, or +1 for THIS user
    this.localVotes = {}

    // dom
    this.elements = {
      status:      document.getElementById('status'),
      pubkey:      document.getElementById('pubkey'),
      generateKeys:document.getElementById('generate-keys'),
      noteContent: document.getElementById('note-content'),
      publishNote: document.getElementById('publish-note'),
      feed:        document.getElementById('feed'),
      showNew:     document.getElementById('show-new')
    }

    // bind UI
    this.bindUI()

    // boot
    this.loadOrGenerateKeys()
    this.connectToRelays()
  }

  bindUI() {
    this.elements.generateKeys?.addEventListener('click', () => this.generateNewKeys())
    this.elements.publishNote?.addEventListener('click', () => this.publishNote())
    this.elements.noteContent?.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') this.publishNote()
    })

    // “Show new posts” buffer flush button
    this.elements.showNew?.addEventListener('click', () => this.flushBufferToFeed())

    // Event delegation for per-post voting
    this.elements.feed?.addEventListener('click', (e) => {
      const btn = e.target.closest('.vote-btn')
      if (!btn) return
      const sign = Number(btn.dataset.sign)   // +1 or -1
      const eid  = btn.dataset.eid            // event id (hex)
      const author = btn.dataset.author       // author pubkey (hex)
      if (!eid || !author || ![1, -1].includes(sign)) return
      this.sendVote(author, eid, sign)
    })
  }

  // ---------- Keys ----------
  loadOrGenerateKeys() {
    const saved = localStorage.getItem('nostr-private-key')
    if (saved) {
      this.privateKey = saved
      this.publicKey = getPublicKey(saved)
    } else {
      this.generateNewKeys()
    }
    this.updateKeyDisplay()
  }

  generateNewKeys() {
    this.privateKey = generatePrivateKey()
    this.publicKey  = getPublicKey(this.privateKey)
    localStorage.setItem('nostr-private-key', this.privateKey)
    this.updateKeyDisplay()
    this.toast('New keys generated! 🎉')
  }

  updateKeyDisplay() {
    if (this.publicKey) this.elements.pubkey.value = nip19.npubEncode(this.publicKey)
  }

  // ---------- Relays ----------
  async connectToRelays() {
    const urls = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.snort.social',
      'wss://relay.nostr.band'
    ]
    this.elements.status.textContent = 'Connecting...'

    for (const url of urls) {
      const relay = relayInit(url)

      relay.on('connect', () => {
        this.connectedRelays.add(url)
        this.updateStatus()

        // If you want NO live updates at all, comment out this line:
        this.subscribeNotes(relay)

        // One-time recent snapshot
        this.fetchRecentBurst(relay)
      })

      relay.on('error', () => {
        this.connectedRelays.delete(url)
        this.updateStatus()
      })

      try {
        await relay.connect()
        this.relays.push(relay)
      } catch (e) {
        console.error('connect error', url, e)
      }
    }

    // If you don't want auto-flush, keep this commented out:
    // this.startAutoFlush()
  }

  updateStatus() {
    const n = this.connectedRelays.size
    this.elements.status.textContent = n > 0 ? `Connected to ${n} relays` : 'Disconnected'
  }

  // ---------- Feed behavior ----------
  // Live subscription: keep open but push into buffer
  subscribeNotes(relay) {
    const sub = relay.sub([{ kinds: [KIND_NOTE], limit: 0 }]) // live only
    sub.on('event', (ev) => this.bufferIncoming(ev))
  }

  // One-shot recent page on (each) connection: gives instant content
  fetchRecentBurst(relay) {
    const recent = relay.sub([{ kinds: [KIND_NOTE], limit: 40 }])
    recent.on('event', (ev) => this.bufferIncoming(ev))
    setTimeout(() => { try { recent.unsub() } catch {} }, 2500)
  }

  bufferIncoming(ev) {
    if (!ev?.id || this.seenIds.has(ev.id)) return
    this.seenIds.add(ev.id)
    this.buffer.push(ev)
    // Update pill
    if (this.elements.showNew) {
      this.elements.showNew.style.display = 'inline-block'
      this.elements.showNew.textContent = `Show new posts (${this.buffer.length})`
    }
  }

  flushBufferToFeed() {
    if (!this.buffer.length) return
    // newest first
    this.buffer.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    for (const ev of this.buffer) this.renderNote(ev, { toTop: true })
    this.buffer = []
    if (this.elements.showNew) {
      this.elements.showNew.style.display = 'none'
      this.elements.showNew.textContent = 'Show new posts (0)'
    }
  }

  startAutoFlush() {
    if (this.bufferTimer) clearInterval(this.bufferTimer)
    this.bufferTimer = setInterval(() => {
      if (this.buffer.length > 0) this.flushBufferToFeed()
    }, this.bufferFlushMs)
  }

  // ---------- Rendering ----------
  renderNote(ev, { toTop = true } = {}) {
    const div = document.createElement('div')
    div.className = 'note'
    const date = new Date((ev.created_at || Math.floor(Date.now()/1000)) * 1000).toLocaleString()
    const short = (ev.pubkey || '').slice(0, 8) + '...' + (ev.pubkey || '').slice(-8)
    const content = this.escapeHtml(ev.content || '')

    // SVG-based vote controls + score
    div.innerHTML = `
      <div class="note-header">
        <span class="note-author">${short}</span>
        <span class="note-time">${date}</span>
      </div>
      <div class="note-content">${content}</div>
      <div class="note-actions" style="margin-top:6px; display:flex; gap:8px; align-items:center;">
        <button class="vote-btn" data-sign="1"  data-author="${ev.pubkey}" data-eid="${ev.id}">▲</button>
        <span id="score-${ev.id}" class="vote-score">…</span>
        <button class="vote-btn" data-sign="-1" data-author="${ev.pubkey}" data-eid="${ev.id}">▼</button>
      </div>
    `

    const feed = this.elements.feed
    if (toTop && feed.firstChild) feed.insertBefore(div, feed.firstChild)
    else feed.appendChild(div)

    while (feed.children.length > 200) feed.removeChild(feed.lastChild)

    // fetch and display score for this post (network-level)
    this.updateScoreForPost(ev.id)
  }

  escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML }

  // ---------- Score / votes ----------
  async updateScoreForPost(eventId) {
    const scoreEl = document.getElementById(`score-${eventId}`)
    if (!scoreEl) return
    scoreEl.textContent = '…'

    const votes = await this.fetchVotesForPost(eventId)
    const score = this.computeScore(votes)

    scoreEl.textContent = score > 0 ? `+${score}` : `${score}`
  }

  async fetchVotesForPost(eventIdHex, timeoutMs = 4000) {
    const results = []
    const filters = [{ kinds: [KIND_KARMA_VOTE], '#e': [eventIdHex], limit: 200 }]

    for (const relay of this.relays) {
      try {
        const events = await this.collectFromRelay(relay, filters, timeoutMs)
        results.push(...events)
      } catch (e) {
        console.warn('vote fetch error on relay', relay.url, e)
      }
    }
    return results
  }

  collectFromRelay(relay, filters, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const out = {}
      const sub = relay.sub(filters)

      sub.on('event', (ev) => { out[ev.id] = ev })

      setTimeout(() => {
        try { sub.unsub() } catch {}
        resolve(Object.values(out))
      }, timeoutMs)
    })
  }

  // one vote per pubkey per post: only the latest vote from each voter counts
  computeScore(voteEvents) {
    const latestByVoter = new Map()

    for (const ev of voteEvents) {
      const signTag = ev.tags.find(t => t[0] === 'v')
      if (!signTag) continue

      const sign = Number(signTag[1])
      // allow 1, -1, 0 (0 = cleared vote)
      if (![1, -1, 0].includes(sign)) continue

      const voter = ev.pubkey
      if (!voter) continue

      const ts = ev.created_at || 0
      const prev = latestByVoter.get(voter)
      if (!prev || ts > prev.ts) {
        latestByVoter.set(voter, { ts, sign })
      }
    }

    let score = 0
    for (const { sign } of latestByVoter.values()) {
      score += sign
    }
    return score
  }

  applyVoteStyles(eventId, sign) {
    const upBtn = document.querySelector(`.vote-btn[data-eid="${eventId}"][data-sign="1"]`)
    const downBtn = document.querySelector(`.vote-btn[data-eid="${eventId}"][data-sign="-1"]`)

    upBtn?.classList.remove('vote-upvoted')
    downBtn?.classList.remove('vote-downvoted')

    if (sign === 1) {
      upBtn?.classList.add('vote-upvoted')
    } else if (sign === -1) {
      downBtn?.classList.add('vote-downvoted')
    }
    // sign === 0 => neither class; both appear neutral
  }

  animateScore(eventId, sign) {
    const scoreEl = document.getElementById(`score-${eventId}`)
    if (!scoreEl) return

    if (sign === 1) {
      scoreEl.classList.remove('vote-flash')
      void scoreEl.offsetWidth
      scoreEl.classList.add('vote-flash')
    } else if (sign === -1) {
      scoreEl.classList.remove('vote-flash-down')
      void scoreEl.offsetWidth
      scoreEl.classList.add('vote-flash-down')
    }
  }

  // ---------- Posting ----------
  async publishNote() {
    const content = (this.elements.noteContent?.value || '').trim()
    if (!content) return alert('Enter content')
    if (this.connectedRelays.size === 0) return alert('Not connected to any relays')

    try {
      this.elements.publishNote.disabled = true
      this.elements.publishNote.textContent = 'Publishing...'

      const created_at = Math.floor(Date.now()/1000)
      const ev = finishEvent({ kind: KIND_NOTE, created_at, tags: [], content }, this.privateKey)

      // Optimistic render (shows immediately, even if relays echo slowly)
      this.renderNote(ev, { toTop: true })

      await Promise.allSettled(this.relays.map(r => r.status === 1 && r.publish(ev)))
      this.elements.noteContent.value = ''
      this.toast('Note published! 🎉')
    } catch (e) {
      console.error('publish error', e)
      this.toast('Failed to publish', 'error')
    } finally {
      this.elements.publishNote.disabled = false
      this.elements.publishNote.textContent = 'Publish Note'
    }
  }

  // ---------- Voting (per-post) ----------
  async sendVote(authorHex, eventIdHex, sign) {
    if (!this.privateKey || !this.publicKey) {
      return this.toast('No keys loaded', 'error')
    }

    const stake = 0
    const powBits = 8

    // toggle logic: clicking same sign again clears vote (0)
    const current = this.localVotes[eventIdHex] || 0
    let finalSign = sign
    if (current === sign) {
      finalSign = 0 // unvote
    }

    const unsigned = {
      kind: KIND_KARMA_VOTE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', authorHex],          // target author
        ['e', eventIdHex],         // the specific note being voted on
        ['v', String(finalSign)],  // +1 / -1 / 0
        ...(stake > 0 ? [['stake', String(stake)]] : []),
        ['client', 'nostr_karma_postvote']
      ],
      content: ''
    }

    const ev = mineAndFinish(unsigned, this.privateKey, powBits, 15000)

    try {
      await Promise.allSettled(this.relays.map(r => r.status === 1 && r.publish(ev)))

      // remember local state
      this.localVotes[eventIdHex] = finalSign

      // UI: colors + flash + new score
      this.applyVoteStyles(eventIdHex, finalSign)
      this.animateScore(eventIdHex, finalSign)
      this.updateScoreForPost(eventIdHex)

      if (finalSign === 0) {
        this.toast('Vote cleared')
      } else {
        this.toast(finalSign > 0 ? 'Upvoted' : 'Downvoted')
      }
    } catch (e) {
      console.error('vote error', e)
      this.toast('Vote failed', 'error')
    }
  }

  // ---------- UI toast ----------
  toast(message, type='success') {
    const n = document.createElement('div')
    n.className = `notification ${type}`
    n.textContent = message
    Object.assign(n.style, {
      position:'fixed', top:'20px', right:'20px', padding:'12px 20px',
      borderRadius:'8px', color:'#fff', fontWeight:'600', zIndex:'1000',
      transform:'translateX(100%)', transition:'transform .3s ease',
      background: type==='error' ? '#ef4444' : '#10b981'
    })
    document.body.appendChild(n)
    setTimeout(()=>{ n.style.transform='translateX(0)' }, 50)
    setTimeout(()=>{
      n.style.transform='translateX(100%)'
      setTimeout(()=>document.body.removeChild(n), 300)
    }, 2800)
  }
}

document.addEventListener('DOMContentLoaded', () => new NostrClient())
