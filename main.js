import { 
    generatePrivateKey, 
    getPublicKey, 
    finishEvent, 
    relayInit,
    nip19
} from 'nostr-tools'

class NostrClient {
    constructor() {
        this.privateKey = null
        this.publicKey = null
        this.relays = []
        this.connectedRelays = new Set()

        this.initializeElements()
        this.setupEventListeners()
        this.loadOrGenerateKeys()
        this.connectToRelays()
    }

    initializeElements() {
        this.elements = {
            status: document.getElementById('status'),
            pubkey: document.getElementById('pubkey'),
            generateKeys: document.getElementById('generate-keys'),
            noteContent: document.getElementById('note-content'),
            publishNote: document.getElementById('publish-note'),
            feed: document.getElementById('feed')
        }
    }

    setupEventListeners() {
        this.elements.generateKeys.addEventListener('click', () => {
            this.generateNewKeys()
        })

        this.elements.publishNote.addEventListener('click', () => {
            this.publishNote()
        })

        // Enable publishing with Ctrl+Enter
        this.elements.noteContent.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                this.publishNote()
            }
        })
    }

    loadOrGenerateKeys() {
        // Try to load existing keys from localStorage
        const savedPrivateKey = localStorage.getItem('nostr-private-key')

        if (savedPrivateKey) {
            this.privateKey = savedPrivateKey
            this.publicKey = getPublicKey(savedPrivateKey)
        } else {
            this.generateNewKeys()
        }

        this.updateKeyDisplay()
    }

    generateNewKeys() {
        this.privateKey = generatePrivateKey()
        this.publicKey = getPublicKey(this.privateKey)

        // Save to localStorage
        localStorage.setItem('nostr-private-key', this.privateKey)

        this.updateKeyDisplay()
        this.showNotification('New keys generated! 🎉')
    }

    updateKeyDisplay() {
        if (this.publicKey) {
            const npub = nip19.npubEncode(this.publicKey)
            this.elements.pubkey.value = npub
        }
    }

    async connectToRelays() {
        const relayUrls = [
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.snort.social'
        ]

        this.updateStatus('Connecting...')

        for (const url of relayUrls) {
            try {
                const relay = relayInit(url)

                relay.on('connect', () => {
                    console.log(`Connected to ${url}`)
                    this.connectedRelays.add(url)
                    this.updateConnectionStatus()
                    this.subscribeToFeed(relay)
                })

                relay.on('error', () => {
                    console.log(`Failed to connect to ${url}`)
                    this.connectedRelays.delete(url)
                    this.updateConnectionStatus()
                })

                await relay.connect()
                this.relays.push(relay)

            } catch (error) {
                console.error(`Error connecting to ${url}:`, error)
            }
        }
    }

    updateConnectionStatus() {
        const connectedCount = this.connectedRelays.size
        if (connectedCount > 0) {
            this.updateStatus(`Connected to ${connectedCount} relays`, 'connected')
        } else {
            this.updateStatus('Disconnected', 'disconnected')
        }
    }

    updateStatus(message, className = '') {
        this.elements.status.textContent = message
        this.elements.status.className = `connection-status ${className}`
    }

    subscribeToFeed(relay) {
        const sub = relay.sub([
            {
                kinds: [1], // Text notes
                limit: 20
            }
        ])

        sub.on('event', (event) => {
            this.addEventToFeed(event)
        })
    }

    addEventToFeed(event) {
        const noteElement = this.createNoteElement(event)

        // Add to top of feed
        if (this.elements.feed.firstChild) {
            this.elements.feed.insertBefore(noteElement, this.elements.feed.firstChild)
        } else {
            this.elements.feed.appendChild(noteElement)
        }

        // Limit feed to 50 notes
        while (this.elements.feed.children.length > 50) {
            this.elements.feed.removeChild(this.elements.feed.lastChild)
        }
    }

    createNoteElement(event) {
        const noteDiv = document.createElement('div')
        noteDiv.className = 'note'

        const date = new Date(event.created_at * 1000)
        const timeString = date.toLocaleString()

        // Truncate public key for display
        const shortPubkey = event.pubkey.slice(0, 8) + '...' + event.pubkey.slice(-8)

        noteDiv.innerHTML = `
            <div class="note-header">
                <span class="note-author">${shortPubkey}</span>
                <span class="note-time">${timeString}</span>
            </div>
            <div class="note-content">${this.escapeHtml(event.content)}</div>
        `

        return noteDiv
    }

    escapeHtml(text) {
        const div = document.createElement('div')
        div.textContent = text
        return div.innerHTML
    }

    async publishNote() {
        const content = this.elements.noteContent.value.trim()

        if (!content) {
            this.showNotification('Please enter some content!', 'error')
            return
        }

        if (this.connectedRelays.size === 0) {
            this.showNotification('Not connected to any relays!', 'error')
            return
        }

        try {
            this.elements.publishNote.disabled = true
            this.elements.publishNote.textContent = 'Publishing...'

            const event = finishEvent({
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                content: content,
            }, this.privateKey)

            // Publish to all connected relays
            const publishPromises = this.relays.map(relay => {
                if (relay.status === 1) { // Connected
                    return relay.publish(event)
                }
            })

            await Promise.allSettled(publishPromises)

            this.elements.noteContent.value = ''
            this.showNotification('Note published! 🎉')

        } catch (error) {
            console.error('Error publishing note:', error)
            this.showNotification('Failed to publish note', 'error')
        } finally {
            this.elements.publishNote.disabled = false
            this.elements.publishNote.textContent = 'Publish Note'
        }
    }

    showNotification(message, type = 'success') {
        // Create notification element
        const notification = document.createElement('div')
        notification.className = `notification ${type}`
        notification.textContent = message

        // Style the notification
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '12px 20px',
            borderRadius: '8px',
            color: 'white',
            fontWeight: '600',
            zIndex: '1000',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s ease'
        })

        if (type === 'error') {
            notification.style.background = '#ef4444'
        } else {
            notification.style.background = '#10b981'
        }

        document.body.appendChild(notification)

        // Animate in
        setTimeout(() => {
            notification.style.transform = 'translateX(0)'
        }, 100)

        // Remove after 3 seconds
        setTimeout(() => {
            notification.style.transform = 'translateX(100%)'
            setTimeout(() => {
                document.body.removeChild(notification)
            }, 300)
        }, 3000)
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new NostrClient()
})
