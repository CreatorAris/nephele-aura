import {
  FlatList, Platform, Image, Modal, Pressable, Dimensions,
  ActionSheetIOS, Alert, Keyboard, StyleSheet, TextInput, View, Text,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useState, useEffect, useRef, useCallback } from 'react';
import { remoteWS, RemoteWebSocket } from '../../utils/websocket';
import * as ImagePicker from 'expo-image-picker';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';

// ─── Types ──────────────────────────────────────────────────────────

type MessageRole = 'user' | 'agent' | 'system';

type ImageAttachment = {
  source: 'eagle' | 'upload';
  itemId?: string;
  uploadUrl?: string;
  thumbUri?: string;
};

type Message = {
  id: string;
  text: string;
  role: MessageRole;
  isStreaming?: boolean;
  toolName?: string;
  image?: ImageAttachment;
};

let _msgId = 0;
const nextId = () => `msg_${Date.now()}_${++_msgId}`;
const STREAMING_ID = '__streaming__';
const SCREEN_W = Dimensions.get('window').width;
const PURPLE = '#b388ff';
const PURPLE_BG = 'rgba(179,136,255,0.1)';
const MAX_GOLD = 'rgba(255,215,0,1)';
const MAX_GOLD_BG = 'rgba(255,215,0,0.12)';

// ─── Eagle Picker ───────────────────────────────────────────────────

type EaglePickerItem = { id: string; name: string; ext: string; width: number; height: number };

function EagleImagePicker({ visible, onClose, onSelect }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (item: EaglePickerItem, thumbUri: string) => void;
}) {
  const [items, setItems] = useState<EaglePickerItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const thumbRequested = useRef<Set<string>>(new Set());
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    setItems([]); setThumbs({}); setTotal(0);
    thumbRequested.current.clear();
    setLoading(true);
    remoteWS.requestEagleSearch({ limit: 60 });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const unsub = remoteWS.onMessage(msg => {
      if (msg.type !== 'event' || !msg.data) return;
      if (msg.action === 'eagle_search' || msg.action === 'eagle_items') {
        const d = msg.data as { items?: EaglePickerItem[]; total?: number };
        setItems(prev => {
          const ids = new Set(prev.map(i => i.id));
          return [...prev, ...(d.items || []).filter(i => !ids.has(i.id))];
        });
        setTotal(d.total || 0);
        setLoading(false);
      }
      if (msg.action === 'eagle_thumbnail') {
        const { itemId, data: b64, mime } = msg.data as { itemId: string; data: string; mime: string };
        if (itemId && b64) setThumbs(p => ({ ...p, [itemId]: `data:${mime};base64,${b64}` }));
      }
    });
    return unsub;
  }, [visible]);

  const requestThumb = useCallback((id: string) => {
    if (thumbRequested.current.has(id)) return;
    thumbRequested.current.add(id);
    remoteWS.requestEagleThumbnail(id);
  }, []);

  const COL = (SCREEN_W - 24) / 3;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[S.pickerRoot, { paddingTop: insets.top || 16 }]}>
        <View style={S.pickerHeader}>
          <Pressable onPress={onClose} hitSlop={12}>
            <MaterialCommunityIcons name="close" size={22} color="#666" />
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={S.pickerTitle}>Eagle</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
        {loading && items.length === 0 ? (
          <View style={S.pickerEmpty}>
            <MaterialCommunityIcons name="loading" size={24} color={PURPLE} />
          </View>
        ) : (
          <FlatList
            data={items} numColumns={3} keyExtractor={i => i.id}
            contentContainerStyle={{ padding: 4 }}
            renderItem={({ item }) => {
              requestThumb(item.id);
              const t = thumbs[item.id];
              return (
                <Pressable onPress={() => onSelect(item, t || '')} style={{ width: COL, padding: 2 }}>
                  <View style={[S.pickerThumb, { height: COL }]}>
                    {t ? <Image source={{ uri: t }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                      : <MaterialCommunityIcons name="image-outline" size={20} color="#d0d0d0" />}
                  </View>
                </Pressable>
              );
            }}
            onEndReached={() => { if (items.length < total && !loading) { setLoading(true); remoteWS.requestEagleSearch({ offset: items.length, limit: 60 }); } }}
            onEndReachedThreshold={0.5}
          />
        )}
      </View>
    </Modal>
  );
}

// ─── Agent Screen ───────────────────────────────────────────────────

export default function AgentScreen() {
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pendingImage, setPendingImage] = useState<ImageAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const listRef = useRef<FlatList>(null);
  const streamBuffer = useRef('');

  // ── Mode state (mirrors desktop HomeView) ──
  // agentMode: "local" | "cloud"
  // subMode:   local → deepThink on/off;  cloud → cloudMax on/off
  const [agentMode, setAgentMode] = useState<'local' | 'cloud'>('cloud');
  const [deepThink, setDeepThink] = useState(false);
  const [cloudMax, setCloudMax] = useState(false);

  // Effective mode sent to desktop
  const effectiveMode = agentMode === 'cloud' && cloudMax ? 'cloud_max' : agentMode;

  // ── Keyboard ──
  const kbHeight = useSharedValue(0);
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, e => { kbHeight.value = withTiming(e.endCoordinates.height, { duration: 250 }); });
    const s2 = Keyboard.addListener(hide, () => { kbHeight.value = withTiming(0, { duration: 200 }); });
    return () => { s1.remove(); s2.remove(); };
  }, [kbHeight]);
  const kbStyle = useAnimatedStyle(() => ({ paddingBottom: kbHeight.value }));

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, []);

  // ── Build conversation history for context ──
  const buildHistory = useCallback((): { role: string; content: string }[] => {
    return messages
      .filter(m => m.role === 'user' || m.role === 'agent')
      .filter(m => m.id !== STREAMING_ID)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  }, [messages]);

  // ── WS Events ──
  useEffect(() => {
    const unsub = remoteWS.onMessage(msg => {
      if (msg.type !== 'event' || !msg.action || !msg.data) return;
      const { action, data } = msg;

      const pushChunk = (chunk: string) => {
        if (!chunk) return;
        streamBuffer.current += chunk;
        setIsAgentBusy(true);
        setMessages(prev => {
          const has = prev.find(m => m.id === STREAMING_ID);
          if (has) return prev.map(m => m.id === STREAMING_ID ? { ...m, text: streamBuffer.current } : m);
          return [...prev, { id: STREAMING_ID, text: streamBuffer.current, role: 'agent' as const, isStreaming: true }];
        });
        scrollToBottom();
      };
      const finalize = (message: string) => {
        setIsAgentBusy(false);
        setMessages(prev => {
          const has = prev.some(m => m.id === STREAMING_ID);
          if (has) return prev.map(m => m.id === STREAMING_ID ? { ...m, id: nextId(), text: message || streamBuffer.current, isStreaming: false } : m);
          if (message) return [...prev, { id: nextId(), text: message, role: 'agent' as const }];
          return prev;
        });
        streamBuffer.current = '';
        scrollToBottom();
      };
      const pushError = (error: string) => {
        setIsAgentBusy(false); streamBuffer.current = '';
        setMessages(prev => [...prev.filter(m => m.id !== STREAMING_ID), { id: nextId(), text: error, role: 'system' as const }]);
        scrollToBottom();
      };

      switch (action) {
        case 'agent_stream_chunk': case 'chat_stream_chunk':
          pushChunk((data.chunk || '') as string); break;
        case 'agent_result': finalize((data.message || '') as string); break;
        case 'chat_stream_finished': finalize((data.message || streamBuffer.current) as string); break;
        case 'agent_error': case 'chat_error': pushError((data.error || 'Unknown error') as string); break;
        case 'agent_thinking': break;
        case 'tool_call_started': {
          const tool = (data.tool || '') as string;
          if (tool) { setMessages(prev => [...prev, { id: nextId(), text: tool, role: 'system', toolName: tool }]); scrollToBottom(); }
          break;
        }
      }
    });
    return unsub;
  }, [scrollToBottom]);

  // ── Actions ──
  const sendMessage = () => {
    const text = input.trim();
    if (!text && !pendingImage) return;
    if (isAgentBusy || uploading) return;
    if (pendingImage?.source === 'upload' && !pendingImage.uploadUrl) return;

    const finalText = text || (pendingImage ? 'Analyze this image' : '');
    setMessages(prev => [...prev, { id: nextId(), text: finalText, role: 'user', image: pendingImage || undefined }]);
    setInput(''); streamBuffer.current = '';

    let imageParam: { source: 'eagle'; itemId: string } | { source: 'upload'; url: string } | undefined;
    if (pendingImage?.source === 'eagle' && pendingImage.itemId) imageParam = { source: 'eagle', itemId: pendingImage.itemId };
    else if (pendingImage?.source === 'upload' && pendingImage.uploadUrl) imageParam = { source: 'upload', url: pendingImage.uploadUrl };

    const sent = remoteWS.sendAgentMessage(finalText, {
      image: imageParam,
      agentMode: effectiveMode,
      deepThink: agentMode === 'local' ? deepThink : false,
      history: buildHistory(),
    });
    setPendingImage(null);
    if (!sent) setMessages(prev => [...prev, { id: nextId(), text: 'Desktop not connected', role: 'system' }]);
    else setIsAgentBusy(true);
    scrollToBottom();
  };

  const abort = () => { remoteWS.send({ type: 'command', action: 'agent_abort' }); setIsAgentBusy(false); };

  const newChat = () => { setMessages([]); streamBuffer.current = ''; setIsAgentBusy(false); };

  const pickFromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (result.canceled || !result.assets?.[0]) return;
    const { uri, mimeType } = result.assets[0];
    setPendingImage({ source: 'upload', thumbUri: uri });
    setUploading(true);
    try {
      const cdnUrl = await RemoteWebSocket.uploadImage(uri, mimeType || 'image/jpeg');
      setPendingImage(p => p?.source === 'upload' ? { ...p, uploadUrl: cdnUrl } : p);
    } catch (e) { Alert.alert('Upload failed', String(e)); setPendingImage(null); }
    finally { setUploading(false); }
  };

  const showAttachMenu = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Eagle', 'Photo Library'], cancelButtonIndex: 0 },
        i => { if (i === 1) setPickerVisible(true); if (i === 2) pickFromGallery(); },
      );
    } else {
      Alert.alert('Attach', undefined, [
        { text: 'Eagle', onPress: () => setPickerVisible(true) },
        { text: 'Photo Library', onPress: pickFromGallery },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const canSend = (input.trim().length > 0 || !!pendingImage) && !isAgentBusy && !uploading;

  // ── Render ──
  const renderMessage = ({ item }: { item: Message }) => {
    if (item.toolName) {
      return (
        <View style={S.toolRow}>
          <MaterialCommunityIcons name="cog" size={12} color={PURPLE} />
          <Text style={S.toolText}>{item.toolName}</Text>
        </View>
      );
    }
    if (item.role === 'system') {
      return <View style={S.sysMsg}><Text style={S.sysText}>{item.text}</Text></View>;
    }
    const isUser = item.role === 'user';
    return (
      <View style={[S.bubble, isUser ? S.bubbleUser : S.bubbleAgent]}>
        {item.image?.thumbUri && (
          <Image source={{ uri: item.image.thumbUri }} style={S.bubbleImg} resizeMode="cover" />
        )}
        {item.image && !item.image.thumbUri && (
          <View style={S.bubbleImgPlaceholder}>
            <MaterialCommunityIcons name="image-outline" size={20} color={PURPLE} />
          </View>
        )}
        <Text style={[S.bubbleText, isUser && { color: '#2d2d2d' }]}>
          {item.text}{item.isStreaming ? '\u258C' : ''}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f5f7' }}>
      {/* New chat button in top-right when conversation exists */}
      {messages.length > 0 && !isAgentBusy && (
        <Pressable onPress={newChat} style={S.newChatBtn} hitSlop={8}>
          <MaterialCommunityIcons name="plus" size={18} color={PURPLE} />
        </Pressable>
      )}

      <FlatList
        ref={listRef} data={messages} keyExtractor={i => i.id}
        keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={messages.length === 0 ? S.emptyContainer : { padding: 16, paddingBottom: 8 }}
        ListEmptyComponent={
          <View style={S.emptyInner}>
            <View style={S.emptyIcon}><MaterialCommunityIcons name="robot-outline" size={32} color="#d0d0d0" /></View>
            <Text style={S.emptyTitle}>Nephele Agent</Text>
            <Text style={S.emptyHint}>Remote control your desktop agent</Text>
          </View>
        }
        renderItem={renderMessage}
        onContentSizeChange={() => { if (messages.length > 0) listRef.current?.scrollToEnd({ animated: true }); }}
      />

      {/* ── Input Card ── */}
      <Animated.View style={[S.bottomArea, { paddingBottom: Math.max(insets.bottom, 12) }, kbStyle]}>
        <View style={[S.inputCard, inputFocused && S.inputCardFocused]}>

          {/* Attached image preview */}
          {pendingImage && (
            <View style={S.attachRow}>
              {pendingImage.thumbUri
                ? <Image source={{ uri: pendingImage.thumbUri }} style={S.attachThumb} resizeMode="cover" />
                : <View style={[S.attachThumb, { backgroundColor: PURPLE_BG, alignItems: 'center', justifyContent: 'center' }]}>
                    <MaterialCommunityIcons name="image" size={16} color={PURPLE} />
                  </View>
              }
              <Text style={S.attachLabel} numberOfLines={1}>
                {uploading ? 'Uploading...' : pendingImage.source === 'eagle' ? 'Eagle' : 'Photo'}
              </Text>
              <Pressable onPress={() => setPendingImage(null)} hitSlop={8}>
                <MaterialCommunityIcons name="close-circle" size={18} color="#ccc" />
              </Pressable>
            </View>
          )}

          {/* Text input */}
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={isAgentBusy ? 'Nephele thinking...' : 'Message...'}
            placeholderTextColor="rgba(102,102,102,0.3)"
            editable={!isAgentBusy}
            onSubmitEditing={sendMessage}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            returnKeyType="send"
            style={S.textInput}
            multiline
            maxLength={2000}
          />

          {/* Divider */}
          <View style={S.divider} />

          {/* Toolbar */}
          <View style={S.toolbar}>
            {/* Mode switcher: Local | Cloud */}
            <View style={S.modeGroup}>
              <Pressable
                onPress={() => setAgentMode('local')}
                style={[S.modePill, agentMode === 'local' && S.modePillActive]}
              >
                <Text style={[S.modeText, agentMode === 'local' && S.modeTextActive]}>Local</Text>
              </Pressable>
              <Pressable
                onPress={() => setAgentMode('cloud')}
                style={[S.modePill, agentMode === 'cloud' && S.modePillActive]}
              >
                <Text style={[S.modeText, agentMode === 'cloud' && S.modeTextActive]}>Cloud</Text>
              </Pressable>
            </View>

            <View style={S.toolbarSep} />

            {/* Sub-mode: Deep Think (local) / MAX (cloud) */}
            {agentMode === 'local' && (
              <Pressable
                onPress={() => setDeepThink(v => !v)}
                style={[S.subModePill, deepThink && { backgroundColor: PURPLE_BG }]}
              >
                <Text style={[S.subModeText, deepThink && { color: PURPLE }]}>Deep Think</Text>
              </Pressable>
            )}
            {agentMode === 'cloud' && (
              <Pressable
                onPress={() => setCloudMax(v => !v)}
                style={[S.subModePill, cloudMax && { backgroundColor: MAX_GOLD_BG, borderColor: MAX_GOLD, borderWidth: 1 }]}
              >
                <Text style={[S.subModeText, cloudMax && { color: MAX_GOLD, fontWeight: '700' }]}>MAX</Text>
              </Pressable>
            )}

            <View style={S.toolbarSep} />

            {/* Attach */}
            <Pressable onPress={showAttachMenu} disabled={isAgentBusy || uploading}
              style={[S.attachPill, pendingImage && { backgroundColor: PURPLE_BG }]}>
              <Text style={{ fontSize: 13 }}>{'\uD83D\uDCCE'}</Text>
              <Text style={[S.attachPillText, pendingImage && { color: PURPLE }]}>
                {pendingImage ? '1' : 'Image'}
              </Text>
            </Pressable>

            <View style={{ flex: 1 }} />

            {/* Send / Stop */}
            {isAgentBusy ? (
              <Pressable onPress={abort} style={S.btnStop}>
                <View style={S.stopSquare} />
              </Pressable>
            ) : (
              <Pressable onPress={sendMessage} style={[S.btnSend, !canSend && { opacity: 0.4 }]} disabled={!canSend}>
                <Text style={S.btnSendArrow}>{'\u2191'}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Animated.View>

      <EagleImagePicker visible={pickerVisible} onClose={() => setPickerVisible(false)}
        onSelect={(item, thumb) => { setPendingImage({ source: 'eagle', itemId: item.id, thumbUri: thumb || undefined }); setPickerVisible(false); }} />
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const S = StyleSheet.create({
  bottomArea: { paddingHorizontal: 12, paddingTop: 8 },
  inputCard: {
    backgroundColor: '#fff', borderRadius: 20,
    borderWidth: 1.5, borderColor: 'rgba(179,136,255,0.3)',
    paddingHorizontal: 14, paddingTop: 6, paddingBottom: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8,
    elevation: 3,
  },
  inputCardFocused: { borderWidth: 2, borderColor: PURPLE },
  textInput: { fontSize: 15, color: '#1d1d1f', paddingVertical: 8, paddingHorizontal: 4, maxHeight: 120, minHeight: 36 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(0,0,0,0.06)', marginVertical: 6, marginHorizontal: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 4 },
  modeGroup: { flexDirection: 'row', gap: 4 },
  modePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(102,102,102,0.15)' },
  modePillActive: { backgroundColor: PURPLE, borderColor: PURPLE },
  modeText: { fontSize: 12, color: '#999' },
  modeTextActive: { color: '#fff', fontWeight: '500' },
  subModePill: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 },
  subModeText: { fontSize: 12, color: '#999' },
  toolbarSep: { width: 1, height: 16, backgroundColor: 'rgba(0,0,0,0.08)' },
  attachPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 },
  attachPillText: { fontSize: 12, color: '#999' },
  btnSend: { width: 32, height: 32, borderRadius: 16, backgroundColor: PURPLE, alignItems: 'center', justifyContent: 'center' },
  btnSendArrow: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: -1 },
  btnStop: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#ff6b6b', alignItems: 'center', justifyContent: 'center' },
  stopSquare: { width: 10, height: 10, borderRadius: 2, backgroundColor: '#fff' },

  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 4 },
  attachThumb: { width: 36, height: 36, borderRadius: 8, backgroundColor: '#e8e8e8', overflow: 'hidden' },
  attachLabel: { flex: 1, fontSize: 13, color: '#888' },

  newChatBtn: {
    position: 'absolute', top: 8, right: 16, zIndex: 10,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
  },

  bubble: { borderRadius: 16, padding: 12, marginBottom: 6, maxWidth: '82%' },
  bubbleUser: { backgroundColor: '#f0eaff', alignSelf: 'flex-end' as const },
  bubbleAgent: { backgroundColor: '#fff', alignSelf: 'flex-start' as const, borderWidth: StyleSheet.hairlineWidth, borderColor: '#eee' },
  bubbleText: { fontSize: 15, color: '#1d1d1f', lineHeight: 21 },
  bubbleImg: { width: 140, height: 140, borderRadius: 10, marginBottom: 8, backgroundColor: '#e8e8e8' },
  bubbleImgPlaceholder: { width: 100, height: 70, borderRadius: 10, marginBottom: 8, backgroundColor: '#f3eeff', alignItems: 'center' as const, justifyContent: 'center' as const },

  toolRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 2 },
  toolText: { fontSize: 12, color: '#aaa' },
  sysMsg: { backgroundColor: 'rgba(204,68,68,0.08)', borderRadius: 12, padding: 10, marginBottom: 6, alignSelf: 'center' as const, maxWidth: '85%' },
  sysText: { fontSize: 13, color: '#c44' },

  emptyContainer: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
  emptyInner: { alignItems: 'center' as const, gap: 8 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#f0f0f0', alignItems: 'center' as const, justifyContent: 'center' as const },
  emptyTitle: { fontSize: 17, fontWeight: '600' as const, color: '#999' },
  emptyHint: { fontSize: 13, color: '#ccc' },

  pickerRoot: { flex: 1, backgroundColor: '#f5f5f7' },
  pickerHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 16, paddingBottom: 12 },
  pickerTitle: { fontSize: 16, fontWeight: '600' as const, color: '#1d1d1f' },
  pickerEmpty: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
  pickerThumb: { borderRadius: 8, backgroundColor: '#e8e8e8', overflow: 'hidden' as const, alignItems: 'center' as const, justifyContent: 'center' as const },
});
