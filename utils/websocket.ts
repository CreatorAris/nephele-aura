import { getToken, isTokenExpired } from './auth';

const RELAY_URL = 'wss://ws.arisfusion.com/ws';

export type RemoteMessage = {
  type: 'command' | 'query' | 'event' | 'status';
  action?: string;
  data?: Record<string, unknown>;
};

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

type Listener = (msg: RemoteMessage) => void;
type StateListener = (state: ConnectionState) => void;
type AuthInvalidListener = () => void;
type DesktopListener = (online: boolean) => void;

// How long to wait for desktop to respond to our initial status query before
// concluding it's offline. The relay accepts our WebSocket regardless of
// whether desktop is connected, so this is the only reliable signal.
const DESKTOP_PROBE_TIMEOUT_MS = 3000;

export class RemoteWebSocket {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private listeners: Set<Listener> = new Set();
  private stateListeners: Set<StateListener> = new Set();
  private authInvalidListeners: Set<AuthInvalidListener> = new Set();
  private desktopListeners: Set<DesktopListener> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;
  private authInvalid = false;  // sticky — stops reconnect loop until re-login
  private desktopOnline = false;
  private desktopProbeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Connect to CF Durable Object relay
   */
  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') return;

    const token = await getToken();
    if (!token) {
      console.log('[WS] No token, skipping connect');
      this.handleAuthInvalid();
      return;
    }

    // Preflight: catch expired tokens before the server has to 401 us
    if (isTokenExpired(token)) {
      console.log('[WS] Token expired locally, redirecting to login');
      this.handleAuthInvalid();
      return;
    }

    this.authInvalid = false;
    this.setState('connecting');

    try {
      this.ws = new WebSocket(`${RELAY_URL}?token=${token}&device=mobile`);

      this.ws.onopen = () => {
        console.log('[WS] Connected to relay');
        this.setState('connected');
        this.reconnectDelay = 3000; // reset backoff
        // We're only connected to the CF relay — desktop may or may not be
        // paired on the other side. Probe by asking for status; if desktop
        // is up its bridge will reply with a status event. Otherwise the
        // timer below flips desktopOnline back to false so the UI stops
        // pretending we're talking to anything.
        this.setDesktopOnline(false);
        if (this.desktopProbeTimer) clearTimeout(this.desktopProbeTimer);
        try { this.requestStatus(); } catch { /* swallow */ }
        this.desktopProbeTimer = setTimeout(() => {
          this.desktopProbeTimer = null;
          if (!this.desktopOnline) {
            console.log('[WS] Desktop probe timed out — desktop offline');
          }
        }, DESKTOP_PROBE_TIMEOUT_MS);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: RemoteMessage = JSON.parse(event.data as string);
          // Relay-level peer notifications (defined in CF Worker RemoteRelay).
          if (msg.type === 'event' && msg.action === 'device_connected') {
            const dev = (msg.data as { device?: string } | undefined)?.device;
            if (dev === 'desktop') this.setDesktopOnline(true);
          } else if (msg.type === 'event' && msg.action === 'device_disconnected') {
            const dev = (msg.data as { device?: string } | undefined)?.device;
            if (dev === 'desktop') this.setDesktopOnline(false);
          } else if (msg.type === 'status') {
            // Any status payload from desktop bridge implicitly proves it's alive.
            this.setDesktopOnline(true);
          }
          this.listeners.forEach(fn => fn(msg));
        } catch (e) {
          console.warn('[WS] Invalid message:', event.data);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[WS] Disconnected:', event.code, event.reason);
        this.setState('disconnected');
        this.setDesktopOnline(false);
        if (this.desktopProbeTimer) {
          clearTimeout(this.desktopProbeTimer);
          this.desktopProbeTimer = null;
        }
        // Detect auth-rejection at the handshake step. The browser-style
        // WebSocket API surfaces "401 Unauthorized" in event.reason and
        // close code 1006 (abnormal). We treat any 401/403 in reason as
        // an auth failure and stop reconnecting.
        const reason = String(event.reason || '');
        if (reason.includes('401') || reason.includes('403')
            || reason.toLowerCase().includes('unauthorized')) {
          this.handleAuthInvalid();
          return;
        }
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[WS] Error:', error);
      };
    } catch (e) {
      console.error('[WS] Connect failed:', e);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  /**
   * Stop the reconnect loop and notify subscribers so the app can clear
   * credentials and bounce to the login screen.
   */
  private handleAuthInvalid(): void {
    this.authInvalid = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* swallow */ }
      this.ws = null;
    }
    this.setState('disconnected');
    this.authInvalidListeners.forEach(fn => {
      try { fn(); } catch (e) { console.warn('[WS] auth listener err', e); }
    });
  }

  /**
   * Subscribe to auth-invalid events (e.g. server returned 401 / token
   * expired locally). Use this in your root layout to bounce to login.
   */
  onAuthInvalid(fn: AuthInvalidListener): () => void {
    this.authInvalidListeners.add(fn);
    return () => this.authInvalidListeners.delete(fn);
  }

  /**
   * Subscribe to desktop-presence changes. This is true only when desktop's
   * bridge has actually paired through the relay — being connected to the
   * relay alone is NOT enough.
   */
  onDesktopStateChange(fn: DesktopListener): () => void {
    this.desktopListeners.add(fn);
    fn(this.desktopOnline);
    return () => this.desktopListeners.delete(fn);
  }

  getDesktopOnline(): boolean {
    return this.desktopOnline;
  }

  private setDesktopOnline(online: boolean): void {
    if (this.desktopOnline === online) return;
    this.desktopOnline = online;
    this.desktopListeners.forEach(fn => {
      try { fn(online); } catch (e) { console.warn('[WS] desktop listener err', e); }
    });
  }

  /**
   * Send a command to desktop
   */
  send(msg: RemoteMessage): boolean {
    if (this.state !== 'connected' || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Request status update
   */
  requestStatus(): boolean {
    return this.send({ type: 'query', action: 'status' });
  }

  // ─── Library browse ─────────────────────────────────────────────────
  // NOTE: action strings (`eagle_*`) are the wire protocol shared with the
  // desktop bridge. Method names dropped the `Eagle` prefix because Aura
  // only ships library operations now; the protocol rename is deferred to
  // a coordinated desktop+mobile change.

  /**
   * Request library folder list
   */
  requestFolders(): boolean {
    return this.send({ type: 'command', action: 'eagle_folders' });
  }

  /**
   * Request library items in a folder (paginated)
   */
  requestItems(folderId: string, offset = 0, limit = 40): boolean {
    return this.send({
      type: 'command', action: 'eagle_items',
      data: { folderId, offset, limit },
    });
  }

  /**
   * Unified search: keyword + tags + rating + folder + ext, paginated.
   * Empty params = recent images (default view).
   */
  requestSearch(params: {
    keyword?: string; tags?: string[]; rating?: number;
    folderId?: string; ext?: string;
    offset?: number; limit?: number;
  } = {}): boolean {
    return this.send({
      type: 'command', action: 'eagle_search',
      data: {
        keyword: params.keyword || '',
        tags: params.tags || [],
        rating: params.rating || 0,
        folderId: params.folderId || '',
        ext: params.ext || '',
        offset: params.offset || 0,
        limit: params.limit || 40,
      },
    });
  }

  /**
   * Pose-based image search. Pass refItemId (library item) or imageBase64.
   */
  requestPoseSearch(params: {
    refItemId?: string; imageBase64?: string;
    folderId?: string; threshold?: number;
  }): boolean {
    return this.send({
      type: 'command', action: 'eagle_pose_search',
      data: params,
    });
  }

  /**
   * Request all tags with counts (cached on desktop)
   */
  requestTags(): boolean {
    return this.send({ type: 'command', action: 'eagle_tags' });
  }

  /**
   * Request a single item's thumbnail (base64)
   */
  requestThumbnail(itemId: string): boolean {
    return this.send({ type: 'command', action: 'eagle_thumbnail', data: { itemId } });
  }

  /**
   * Request original full-resolution image (base64, up to 5MB)
   */
  requestFullImage(itemId: string): boolean {
    return this.send({ type: 'command', action: 'eagle_full_image', data: { itemId } });
  }

  /**
   * Fetch full detail for a single item (re-reads metadata.json on desktop).
   * Server emits `eagle_item_detail` with `{itemId, item?, error?}`.
   */
  requestItemDetail(itemId: string): boolean {
    return this.send({
      type: 'command', action: 'eagle_item_detail',
      data: { itemId },
    });
  }

  // ─── Library mutations ──────────────────────────────────────────────

  /**
   * Update a library item's editable fields. Server emits `eagle_update_result`
   * event with `{itemId, success, error?}`.
   *
   * @param itemId - library item id
   * @param fields - Subset of {tags, star, annotation, url}; omitted fields untouched
   */
  updateItem(
    itemId: string,
    fields: { tags?: string[]; star?: number; annotation?: string; url?: string },
  ): boolean {
    return this.send({
      type: 'command', action: 'eagle_update_item',
      data: { itemId, fields },
    });
  }

  /**
   * Move a library item to the trash (soft-delete).
   * Server emits `eagle_trash_result` with `{itemId, success, error?}`.
   */
  trashItem(itemId: string): boolean {
    return this.send({
      type: 'command', action: 'eagle_trash_item',
      data: { itemId },
    });
  }

  /**
   * Create a folder under `parentId` (empty = root).
   * Server emits `eagle_folder_created` with `{success, folderId?, name?, error?}`.
   */
  createFolder(name: string, parentId?: string): boolean {
    return this.send({
      type: 'command', action: 'eagle_create_folder',
      data: { name, parentId: parentId || '' },
    });
  }

  /**
   * Rename an existing folder.
   * Server emits `eagle_folder_renamed` with `{folderId, success, newName?, error?}`.
   */
  renameFolder(folderId: string, newName: string): boolean {
    return this.send({
      type: 'command', action: 'eagle_rename_folder',
      data: { folderId, newName },
    });
  }

  /**
   * Apply the same field changes to many items in one round-trip. Server
   * emits a single `eagle_batch_update_result` with `{success, processed,
   * failed, failedIds?}` once the whole batch completes.
   */
  batchUpdateItems(
    itemIds: string[],
    fields: { tags?: string[]; star?: number; annotation?: string },
  ): boolean {
    return this.send({
      type: 'command', action: 'eagle_batch_update',
      data: { itemIds, fields },
    });
  }

  /**
   * Import a batch of already-uploaded R2 images into the desktop's library.
   * Server downloads each URL, calls `lib.import_file` per item, cleans up
   * temps. Progress arrives as `eagle_batch_import_progress` events
   * ({index, total, ok}); a final `eagle_batch_import_result`
   * ({success, processed, failed, total}) lands when the batch completes.
   *
   * Caller is responsible for the R2 PUT step (use static `uploadImage`).
   */
  importFiles(
    urls: string[],
    options?: { folderId?: string; tags?: string[] },
  ): boolean {
    return this.send({
      type: 'command', action: 'eagle_batch_import',
      data: {
        urls,
        folderId: options?.folderId || '',
        tags: options?.tags || [],
      },
    });
  }

  /**
   * Upload a local image file to R2 relay and return the CDN URL.
   * Used for phone gallery → desktop transfer.
   */
  static async uploadImage(localUri: string, mime: string = 'image/jpeg'): Promise<string> {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const key = `remote_${Date.now().toString(36)}.${ext}`;
    const url = `https://files.arisfusion.com/upload/${key}`;

    const resp = await fetch(localUri);
    const blob = await resp.blob();

    const uploadResp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: blob,
    });

    if (!uploadResp.ok) {
      throw new Error(`Upload failed: ${uploadResp.status}`);
    }

    const result = await uploadResp.json() as { url?: string };
    if (!result.url) throw new Error('No URL in upload response');
    return result.url;
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  /**
   * Subscribe to messages
   */
  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Subscribe to connection state changes
   */
  onStateChange(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    fn(this.state); // immediately emit current state
    return () => this.stateListeners.delete(fn);
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.stateListeners.forEach(fn => fn(state));
  }

  private scheduleReconnect(): void {
    if (this.authInvalid || this.reconnectTimer) return;
    console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff, max 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
  }
}

// Singleton
export const remoteWS = new RemoteWebSocket();
