import { getToken } from './auth';

const RELAY_URL = 'wss://ws.arisfusion.com/ws';

export type RemoteMessage = {
  type: 'command' | 'query' | 'event' | 'status';
  action?: string;
  data?: Record<string, unknown>;
};

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

type Listener = (msg: RemoteMessage) => void;
type StateListener = (state: ConnectionState) => void;

export class RemoteWebSocket {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private listeners: Set<Listener> = new Set();
  private stateListeners: Set<StateListener> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;

  /**
   * Connect to CF Durable Object relay
   */
  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') return;

    const token = await getToken();
    if (!token) {
      console.log('[WS] No token, skipping connect');
      return;
    }

    this.setState('connecting');

    try {
      this.ws = new WebSocket(`${RELAY_URL}?token=${token}&device=mobile`);

      this.ws.onopen = () => {
        console.log('[WS] Connected to relay');
        this.setState('connected');
        this.reconnectDelay = 3000; // reset backoff
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: RemoteMessage = JSON.parse(event.data as string);
          this.listeners.forEach(fn => fn(msg));
        } catch (e) {
          console.warn('[WS] Invalid message:', event.data);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[WS] Disconnected:', event.code, event.reason);
        this.setState('disconnected');
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
   * Send a command to desktop
   */
  send(msg: RemoteMessage): boolean {
    if (this.state !== 'connected' || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Send agent message to desktop, optionally with an attached image.
   *
   * @param text - The message text
   * @param image - Optional image attachment:
   *   - { source: 'eagle', itemId: string } — attach an Eagle library item
   *   - { source: 'upload', url: string }   — attach an uploaded image (R2 CDN URL)
   */
  sendAgentMessage(
    text: string,
    opts?: {
      image?: { source: 'eagle'; itemId: string } | { source: 'upload'; url: string };
      agentMode?: 'cloud' | 'cloud_max' | 'local';
      deepThink?: boolean;
      history?: { role: string; content: string }[];
    },
  ): boolean {
    const data: Record<string, unknown> = {
      text,
      agentMode: opts?.agentMode || 'cloud',
      deepThink: opts?.deepThink || false,
    };
    if (opts?.history?.length) data.history = opts.history;
    if (opts?.image) {
      data.imageSource = opts.image.source;
      if (opts.image.source === 'eagle') data.imageId = opts.image.itemId;
      if (opts.image.source === 'upload') data.imageUrl = opts.image.url;
    }
    return this.send({ type: 'command', action: 'agent_send', data });
  }

  /**
   * Abort current agent task
   */
  sendAgentAbort(): boolean {
    return this.send({ type: 'command', action: 'agent_abort' });
  }

  /**
   * Request pipeline start
   */
  sendPipelineStart(config?: Record<string, unknown>): boolean {
    return this.send({ type: 'command', action: 'pipeline_start', data: config });
  }

  /**
   * Request status update
   */
  requestStatus(): boolean {
    return this.send({ type: 'query', action: 'status' });
  }

  /**
   * Request Eagle folder list
   */
  requestEagleFolders(): boolean {
    return this.send({ type: 'command', action: 'eagle_folders' });
  }

  /**
   * Request Eagle items in a folder (paginated)
   */
  requestEagleItems(folderId: string, offset = 0, limit = 40): boolean {
    return this.send({
      type: 'command', action: 'eagle_items',
      data: { folderId, offset, limit },
    });
  }

  /**
   * Unified search: keyword + tags + rating + folder + ext, paginated.
   * Empty params = recent images (default view).
   */
  requestEagleSearch(params: {
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
   * Pose-based image search. Pass refItemId (Eagle item) or imageBase64.
   */
  requestEaglePoseSearch(params: {
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
  requestEagleTags(): boolean {
    return this.send({ type: 'command', action: 'eagle_tags' });
  }

  /**
   * Request a single item's thumbnail (base64)
   */
  requestEagleThumbnail(itemId: string): boolean {
    return this.send({ type: 'command', action: 'eagle_thumbnail', data: { itemId } });
  }

  /**
   * Request original full-resolution image (base64, up to 5MB)
   */
  requestEagleFullImage(itemId: string): boolean {
    return this.send({ type: 'command', action: 'eagle_full_image', data: { itemId } });
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
    if (this.reconnectTimer) return;
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
