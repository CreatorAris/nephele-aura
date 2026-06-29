import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { YStack, XStack, Text, Spinner } from 'tamagui';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import Markdown from 'react-native-markdown-display';
import { ArrowUp, Square, Sparkles, ChevronDown, ChevronUp, ChevronRight, Zap, Monitor, Wrench, Check, X as XIcon, ImageOff, History, Plus } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { GlassCard } from '../../components/GlassCard';
import { TAB_BAR_RAISED_CLEARANCE } from '../../components/FloatingTabBar';
import { streamAssistant, stripMarkers, type ChatTurn, type Source } from '../../utils/agent';
import { remoteWS, type RemoteMessage } from '../../utils/websocket';
import { isLoggedIn } from '../../utils/auth';
import { useLightboxControls, type ImageSource as LbImageSource } from '../../components/Lightbox';
import { standardImageActions } from '../../utils/lightboxActions';
import AsyncStorage from '@react-native-async-storage/async-storage';
import analytics from '../../utils/analytics';

// A tool the desktop agent invoked during this turn — rendered as a status row.
interface ToolCall {
  name: string;
  status: 'running' | 'ok' | 'fail';
  summary?: string;
}

// One image surfaced by show_reference_picker. eagleId images fetch their
// pixels over the relay (same path as the gallery); http-src images (Pixiv
// proxy / Pinterest CDN) load directly. Desktop-local file:// paths are
// dropped upstream — mobile can't reach them.
interface PickerImage {
  key: string;
  eagleId?: string;
  src?: string;       // http(s) thumbnail when not an Eagle item
  srcLarge?: string;  // http(s) full-res for the lightbox
  name?: string;
  width?: number;
  height?: number;
}

// A forwarded ask_user_question the agent is blocked on — answerable on mobile.
interface QOption { label: string; description?: string }
interface QItem { question: string; header?: string; options: QOption[]; multiSelect?: boolean }
interface AgentQuestion { questionId: string; questions: QItem[] }

// A desktop chat-history session (browsable from mobile).
interface ChatSession { id: string; title: string; updatedAt: string; count: number }

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  sources: Source[];
  tools: ToolCall[];
  picker: PickerImage[];
  question?: AgentQuestion;  // agent paused on ask_user_question, awaiting mobile answer
  stamina?: number;
  streaming: boolean;
}

let _seq = 0;
const uid = () => `m${Date.now()}_${_seq++}`;

const HISTORY_KEY = 'assistant_history_v1';  // persisted conversation (last 40 msgs)

// Compact one-line summary of a tool result for the status row — strip the
// PICKER blob, drop model-directed hint tails (sample_ids / 看图 / retry
// templates that are guidance for the LLM, not the user), cap length.
function summariseToolResult(result: string): string {
  let clean = (result || '')
    .replace(/<!--PICKER:[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const marker of ['sample_ids=', ' 看图', ' 0 结果', ' retry']) {
    const i = clean.indexOf(marker);
    if (i > 0) clean = clean.slice(0, i).trim();
  }
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

// Finalize an in-flight assistant message that was cut short (manual stop or
// desktop drop): stop the typewriter, flip any still-running tool rows to
// failed so they don't spin forever, and fall back to `note` if no text landed.
function markInterrupted(m: Msg, note: string): Msg {
  return {
    ...m,
    streaming: false,
    question: undefined,  // a stale question card can't be answered once the turn is dead
    tools: m.tools.map((t) => (t.status === 'running' ? { ...t, status: 'fail' as const } : t)),
    text: m.text || note,
  };
}

// Pull the <!--PICKER:{json}--> payload the desktop embeds in a
// show_reference_picker result. Returns renderable images, dropping any that
// are desktop-local only (no eagle_id and no http src).
function parsePickerImages(result: string): PickerImage[] {
  const m = /<!--PICKER:([\s\S]*?)-->/.exec(result || '');
  if (!m) return [];
  let payload: { images?: Record<string, unknown>[] };
  try { payload = JSON.parse(m[1]); } catch { return []; }
  const out: PickerImage[] = [];
  for (const img of payload.images ?? []) {
    const eagleId = (img.eagle_id as string) || '';
    const rawSrc = (img.src as string) || '';
    const httpSrc = rawSrc.startsWith('http') ? rawSrc : '';
    const rawLarge = (img.src_large as string) || '';
    const httpLarge = rawLarge.startsWith('http') ? rawLarge : '';
    if (!eagleId && !httpSrc) continue;  // file:// / local-only → unreachable
    out.push({
      key: eagleId || httpSrc,
      eagleId: eagleId || undefined,
      src: httpSrc || undefined,
      srcLarge: httpLarge || httpSrc || undefined,
      name: (img.name as string) || (img.alt as string) || '',
      width: (img.width as number) || 0,
      height: (img.height as number) || 0,
    });
  }
  return out;
}

// Real prompts verified against the desktop agent (pulled from Cloud MAX run
// history) — these exercise find_references end-to-end rather than generic chat.
const SUGGESTIONS = ['最近有哪些值得关注的 AI 绘画工具？', '厚涂和赛璐璐上色有什么区别？', '赛博朋克场景的配色思路？'];

// Markdown rendered with the dark theme tokens (mirrors desktop's MarkdownText).
const mdStyles = {
  body: { color: colors.text.primary, fontSize: 14, lineHeight: 21 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  link: { color: colors.brand.primary },
  code_inline: { backgroundColor: colors.bg.subtle, color: colors.text.secondary, borderRadius: 4, paddingHorizontal: 4 },
  fence: { backgroundColor: colors.bg.subtle, color: colors.text.secondary, borderRadius: 8, padding: 10, borderWidth: 0 },
  code_block: { backgroundColor: colors.bg.subtle, color: colors.text.secondary, borderRadius: 8, padding: 10 },
  bullet_list: { marginBottom: 6 },
  ordered_list: { marginBottom: 6 },
  heading1: { color: colors.text.primary, fontSize: 18, fontWeight: '700' as const, marginBottom: 6 },
  heading2: { color: colors.text.primary, fontSize: 16, fontWeight: '700' as const, marginBottom: 6 },
  blockquote: { backgroundColor: colors.bg.subtle, borderColor: colors.border.default, borderLeftWidth: 3, paddingHorizontal: 10 },
  hr: { backgroundColor: colors.border.subtle },
};

const ThinkingStrip = memo(function ThinkingStrip({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  return (
    <YStack backgroundColor="rgba(206,172,224,0.07)" borderColor="rgba(206,172,224,0.16)" borderWidth={1}
      borderRadius={10} padding={8} marginBottom={6}>
      <Pressable onPress={() => setOpen((v) => !v)}>
        <XStack alignItems="center" gap={6}>
          <Text color={colors.brand.primary} fontSize={11}>∴</Text>
          <Text color={colors.brand.primary} fontSize={11} fontWeight="500" opacity={streaming ? 1 : 0.7}>
            {streaming ? '思考中' : '已思考'}
          </Text>
          <YStack flex={1} />
          {open ? <ChevronDown size={12} color={colors.brand.primary} /> : <ChevronRight size={12} color={colors.brand.primary} />}
        </XStack>
      </Pressable>
      {open && (
        <Text color={colors.text.secondary} fontSize={12} fontStyle="italic" lineHeight={17} marginTop={4} opacity={0.85}>
          {text || '正在思考...'}
        </Text>
      )}
    </YStack>
  );
});

// One desktop tool invocation — name + live status, mirrors the desktop's
// ToolCallItem (running spinner → ✓ / ✕ + a short result line).
const ToolRow = memo(function ToolRow({ tool }: { tool: ToolCall }) {
  return (
    <XStack testID={`agent-tool-${tool.name}`} alignItems="center" gap={6} backgroundColor={colors.bg.subtle}
      borderColor={colors.border.subtle} borderWidth={1} borderRadius={9}
      paddingHorizontal={9} paddingVertical={6} marginBottom={4}>
      <Wrench size={12} color={colors.text.tertiary} />
      <Text color={colors.text.secondary} fontSize={12} fontWeight="600">{tool.name}</Text>
      {tool.status === 'running' && tool.name === 'run_python' ? (
        // run_python blocks on a desktop confirmation dialog — set expectations
        // so the spinner doesn't read as a hang.
        <Text flex={1} color={colors.status.warning} fontSize={11} numberOfLines={1}>等待桌面确认…</Text>
      ) : tool.summary ? (
        <Text flex={1} color={colors.text.tertiary} fontSize={11} numberOfLines={1}>{tool.summary}</Text>
      ) : <YStack flex={1} />}
      {tool.status === 'running' ? <Spinner size="small" color={colors.brand.primary} />
        : tool.status === 'ok' ? <Check size={13} color={colors.status.success} />
        : <XIcon size={13} color={colors.status.error} />}
    </XStack>
  );
});

const PICKER_THUMB = 92;

// One picker thumbnail. Eagle pixels stream in via the relay (uri may be
// undefined until then → spinner); http images load directly and fall back to
// a placeholder if the source 404s / blocks hotlinking.
const PickerCell = memo(function PickerCell({
  im, idx, thumbs, onPress,
}: { im: PickerImage; idx: number; thumbs: Record<string, string>; onPress: () => void }) {
  const [failed, setFailed] = useState(false);
  const uri = im.eagleId ? thumbs[im.eagleId] : im.src;
  return (
    <Pressable testID={`picker-cell-${idx}`} accessibilityLabel={im.name || undefined} onPress={onPress}>
      <YStack width={PICKER_THUMB} height={PICKER_THUMB} borderRadius={10} overflow="hidden"
        backgroundColor={colors.bg.subtle} borderWidth={1} borderColor={colors.border.subtle}
        justifyContent="center" alignItems="center">
        {failed ? (
          <ImageOff size={20} color={colors.text.faint} />
        ) : uri ? (
          <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover"
            transition={0} onError={() => setFailed(true)} />
        ) : (
          <Spinner size="small" color={colors.brand.primary} />
        )}
      </YStack>
    </Pressable>
  );
});

const PICKER_COLLAPSED = 6;  // show a peek, fold the rest — a 40+ image dump buries the chat

// Grid of reference-picker thumbnails, folded by default so a big result set
// doesn't flood the timeline. Tap a cell → shared lightbox.
const PickerGrid = memo(function PickerGrid({
  images, thumbs, onOpen,
}: { images: PickerImage[]; thumbs: Record<string, string>; onOpen: (idx: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? images : images.slice(0, PICKER_COLLAPSED);
  const overflow = images.length - PICKER_COLLAPSED;
  return (
    <YStack testID="picker-grid" marginTop={6} marginBottom={2} gap={8}>
      <XStack flexWrap="wrap" gap={6}>
        {shown.map((im, idx) => (
          <PickerCell key={im.key} im={im} idx={idx} thumbs={thumbs} onPress={() => onOpen(idx)} />
        ))}
      </XStack>
      {overflow > 0 && (
        <Pressable testID="picker-toggle" onPress={() => setExpanded((v) => !v)} hitSlop={6}>
          <XStack alignSelf="flex-start" alignItems="center" gap={4} borderRadius={9} paddingHorizontal={11}
            paddingVertical={7} borderWidth={1} borderColor={colors.border.default} backgroundColor={colors.bg.subtle}>
            <Text color={colors.brand.primary} fontSize={12} fontWeight="600">
              {expanded ? '收起' : `展开全部 ${images.length} 张`}
            </Text>
            {expanded
              ? <ChevronUp size={13} color={colors.brand.primary} />
              : <ChevronDown size={13} color={colors.brand.primary} />}
          </XStack>
        </Pressable>
      )}
    </YStack>
  );
});

// Renders a forwarded ask_user_question as tappable choices. Single-select per
// question; multiSelect toggles. 提交 routes the answers back to the desktop
// agent (same path as its own dialog); 跳过 sends {} (the agent treats it as
// "user skipped" and continues).
const QuestionCard = memo(function QuestionCard({ q, onAnswer }: {
  q: AgentQuestion;
  onAnswer: (questionId: string, answers: Record<string, string | string[]>) => void;
}) {
  const [sel, setSel] = useState<Record<string, string | string[]>>({});
  const pick = (qtext: string, label: string, multi: boolean) => {
    setSel((prev) => {
      if (!multi) return { ...prev, [qtext]: label };
      const cur = Array.isArray(prev[qtext]) ? (prev[qtext] as string[]) : [];
      return { ...prev, [qtext]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });
  };
  const allAnswered = q.questions.every((it) => {
    const v = sel[it.question];
    return it.multiSelect ? Array.isArray(v) && v.length > 0 : !!v;
  });
  return (
    <YStack testID="agent-question" backgroundColor={colors.bg.surface} borderColor={colors.status.warning}
      borderWidth={1} borderRadius={12} padding={12} gap={12} marginVertical={4}>
      {q.questions.map((it, qi) => (
        <YStack key={qi} gap={6}>
          {it.header ? <Text color={colors.status.warning} fontSize={11} fontWeight="700">{it.header}</Text> : null}
          <Text color={colors.text.primary} fontSize={14} fontWeight="600">{it.question}</Text>
          {it.options.map((opt) => {
            const v = sel[it.question];
            const chosen = it.multiSelect ? (Array.isArray(v) && v.includes(opt.label)) : v === opt.label;
            return (
              <Pressable key={opt.label} testID={`q-opt-${opt.label}`} onPress={() => pick(it.question, opt.label, !!it.multiSelect)}>
                <YStack borderRadius={9} paddingHorizontal={11} paddingVertical={9} borderWidth={1}
                  backgroundColor={chosen ? 'rgba(206,172,224,0.14)' : 'transparent'}
                  borderColor={chosen ? colors.brand.primary : colors.border.default}>
                  <Text color={chosen ? colors.brand.primary : colors.text.primary} fontSize={13}
                    fontWeight={chosen ? '700' : '500'}>{opt.label}</Text>
                  {opt.description ? (
                    <Text color={colors.text.tertiary} fontSize={11} marginTop={2}>{opt.description}</Text>
                  ) : null}
                </YStack>
              </Pressable>
            );
          })}
        </YStack>
      ))}
      <XStack gap={8} justifyContent="flex-end" alignItems="center">
        <Pressable testID="q-skip" onPress={() => onAnswer(q.questionId, {})} hitSlop={6}>
          <Text color={colors.text.tertiary} fontSize={13} paddingHorizontal={8}>跳过</Text>
        </Pressable>
        <Pressable testID="q-submit" disabled={!allAnswered} onPress={() => onAnswer(q.questionId, sel)}>
          <YStack borderRadius={9} paddingHorizontal={16} paddingVertical={8} opacity={allAnswered ? 1 : 0.4}
            backgroundColor={colors.brand.primary}>
            <Text color={colors.bg.canvas} fontSize={13} fontWeight="700">提交</Text>
          </YStack>
        </Pressable>
      </XStack>
    </YStack>
  );
});

const MessageRow = memo(function MessageRow({ msg, onSource, pickerThumbs, onOpenPicker, onAnswerQuestion }: {
  msg: Msg;
  onSource: (uri: string) => void;
  pickerThumbs: Record<string, string>;
  onOpenPicker: (images: PickerImage[], idx: number) => void;
  onAnswerQuestion: (questionId: string, answers: Record<string, string | string[]>) => void;
}) {
  const isUser = msg.role === 'user';
  const body = isUser ? msg.text : stripMarkers(msg.text);

  // Text renders as it actually arrives over SSE — no client typewriter. The
  // cursor shows while the turn is in flight.
  const hasFirstToken = body.length > 0 || msg.thinking.length > 0;
  const showCursor = !isUser && msg.streaming;

  return (
    <XStack testID={isUser ? 'msg-user' : 'msg-assistant'} paddingHorizontal={16} paddingVertical={8} gap={6}>
      {/* Role gutter (28px): assistant spinner→dot, user chevron */}
      <YStack width={22} alignItems="center" paddingTop={2}>
        {isUser ? (
          <Text color={colors.brand.primary} fontSize={13}>▸</Text>
        ) : msg.streaming && !hasFirstToken ? (
          <Spinner size="small" color={colors.brand.primary} />
        ) : (
          <YStack width={8} height={8} borderRadius={4} backgroundColor={colors.brand.primary} marginTop={5} />
        )}
      </YStack>

      <YStack flex={1} gap={4}>
        <Text color={colors.text.primary} fontSize={12} fontWeight="600">{isUser ? '你' : 'Nephele'}</Text>

        {!isUser && msg.thinking.length > 0 && <ThinkingStrip text={msg.thinking} streaming={msg.streaming} />}

        {!isUser && msg.tools.length > 0 && (
          <YStack marginTop={2}>
            {msg.tools.map((t, i) => <ToolRow key={`${t.name}-${i}`} tool={t} />)}
          </YStack>
        )}

        {!isUser && msg.streaming && msg.question && (
          <QuestionCard q={msg.question} onAnswer={onAnswerQuestion} />
        )}

        {body.length > 0 ? (
          isUser ? (
            <Text color={colors.text.primary} fontSize={14} lineHeight={21}>{body}</Text>
          ) : (
            <Markdown style={mdStyles as any}>{body + (showCursor ? ' ▍' : '')}</Markdown>
          )
        ) : !isUser && msg.streaming && msg.tools.length === 0 ? (
          <Text color={colors.text.tertiary} fontSize={14}>正在思考…</Text>
        ) : null}

        {!isUser && msg.picker.length > 0 && (
          <PickerGrid images={msg.picker} thumbs={pickerThumbs} onOpen={(idx) => onOpenPicker(msg.picker, idx)} />
        )}

        {/* Sources (grounding) */}
        {msg.sources.length > 0 && (
          <XStack flexWrap="wrap" gap={6} marginTop={2}>
            <Text color={colors.text.tertiary} fontSize={11} alignSelf="center">参考来源</Text>
            {msg.sources.map((s) => (
              <Pressable key={s.uri} onPress={() => onSource(s.uri)}>
                <YStack backgroundColor={colors.bg.surface} borderColor={colors.border.subtle} borderWidth={1}
                  borderRadius={12} paddingHorizontal={9} height={24} justifyContent="center" maxWidth={180}>
                  <Text color={colors.text.secondary} fontSize={11} numberOfLines={1}>{s.title}</Text>
                </YStack>
              </Pressable>
            ))}
          </XStack>
        )}

        {!isUser && !msg.streaming && msg.stamina != null && msg.stamina > 0 && (
          <Text color={colors.text.tertiary} fontSize={11} opacity={0.6} marginTop={2}>-{msg.stamina} 云晶</Text>
        )}
      </YStack>
    </XStack>
  );
});

export default function AssistantScreen() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // Model tier: Zephyr = fast/cheap, Tempest = full power (maps to model_tier).
  // HONORED end-to-end on BOTH paths now — the cloud /v1/chat/max path and the
  // desktop relay (the desktop runs cloud_max_zephyr / cloud_max for the picked
  // tier instead of the old force-Tempest).
  const [tier, setTier] = useState<'zephyr' | 'tempest'>('zephyr');
  // Desktop presence drives routing: online → auto-route the turn to the
  // desktop's full Cloud MAX agent (local library / files / run_python /
  // reference picker) running the picked tier; offline → cloud tier only.
  const [desktopOnline, setDesktopOnline] = useState(() => remoteWS.getDesktopOnline());
  const abortRef = useRef<AbortController | null>(null);
  // True while a desktop-agent turn is in flight, so the relay event handler
  // knows to route agent_* events into the current assistant message.
  const awaitingDesktopRef = useRef(false);
  const desktopT0Ref = useRef(0);  // turn start, for completion-latency telemetry
  // Picker pixels arrive over the relay (Eagle items only): eagleId → base64
  // data URI for the grid, eagleId → R2 URL for the lightbox full view.
  const [pickerThumbs, setPickerThumbs] = useState<Record<string, string>>({});
  const pickerFull = useRef<Record<string, string>>({});
  const pickerReq = useRef<Set<string>>(new Set());
  const { openLightbox: openLightboxControl } = useLightboxControls();
  // Desktop chat-history browser (B): session list + load-into-view.
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const [kbVisible, setKbVisible] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);

  // Desktop presence drives routing (online → auto-route to the desktop agent)
  // and the header status pill. A drop mid-turn must finalize the in-flight
  // message so it doesn't stream forever.
  useEffect(() => remoteWS.onDesktopStateChange((online) => {
    setDesktopOnline(online);
    if (!online) {
      if (awaitingDesktopRef.current) {
        awaitingDesktopRef.current = false;
        setStreaming(false);
        setMessages((prev) => (prev.length
          ? [...prev.slice(0, -1), markInterrupted(prev[prev.length - 1], '⚠ 桌面连接已断开')]
          : prev));
      }
    }
  }), []);

  // Ensure the relay is connected even if the user lands here without visiting
  // the gallery first — otherwise desktop presence never resolves and MAX
  // stays locked. The singleton no-ops if already connected.
  useFocusEffect(useCallback(() => {
    (async () => { if (await isLoggedIn()) remoteWS.connect(); })();
  }, []));

  // Persist the conversation so it survives tab switches / relaunches (it was
  // in-memory only before). Restore once on mount; debounce-save on change.
  useEffect(() => {
    AsyncStorage.getItem(HISTORY_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as Msg[];
        if (Array.isArray(saved) && saved.length) {
          // Never restore a half-streamed/awaiting state as live.
          setMessages(saved.map((m) => ({ ...m, streaming: false, question: undefined })));
        }
      } catch { /* corrupt blob — ignore */ }
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!messages.length) return;  // don't let the initial empty render wipe a saved history before restore lands
    const t = setTimeout(() => {
      const toSave = messages.slice(-40).map((m) => ({ ...m, streaming: false }));
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(toSave)).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [messages]);

  // Lift the content above the IME ourselves. Under edge-to-edge (Expo SDK 54
  // default) the window no longer shrinks for the keyboard, so `adjustResize`
  // and a platform-branched KeyboardAvoidingView leave the composer behind the
  // keyboard. We track the real IME height and pad the content container by it.
  // iOS gets the will* events (fire before the animation, so the lift stays in
  // sync); Android only emits did*.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => {
      setKbVisible(true);
      setKbHeight(e.endCoordinates?.height ?? 0);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    });
    const hide = Keyboard.addListener(hideEvt, () => { setKbVisible(false); setKbHeight(0); });
    return () => { show.remove(); hide.remove(); };
  }, []);
  // While the keyboard is up the content container already lifts by kbHeight, so
  // the composer only needs a small gap; idle, it must clear the raised FAB ball.
  const composerPad = kbVisible ? 10 : insets.bottom + TAB_BAR_RAISED_CLEARANCE;

  const updateLast = useCallback((fn: (m: Msg) => Msg) => {
    setMessages((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev));
  }, []);

  // Desktop Cloud MAX agent events (relay-forwarded). Only consumed while a
  // desktop turn is in flight; the cloud-chat path uses streamAssistant instead.
  useEffect(() => remoteWS.onMessage((msg: RemoteMessage) => {
    if (msg.type !== 'event') return;
    const d = (msg.data ?? {}) as Record<string, unknown>;

    // Picker pixels arrive asynchronously and can land AFTER the agent turn
    // ends, so these two aren't gated by awaitingDesktopRef — but we only keep
    // thumbnails we actually requested for a picker (gallery requests share the
    // same event but a different listener).
    if (msg.action === 'eagle_thumbnail') {
      const itemId = String(d.itemId ?? '');
      if (itemId && d.data && pickerReq.current.has(itemId)) {
        const uri = `data:${String(d.mime || 'image/jpeg')};base64,${String(d.data)}`;
        setPickerThumbs((prev) => (prev[itemId] ? prev : { ...prev, [itemId]: uri }));
      }
      return;
    }
    if (msg.action === 'eagle_full_image') {
      const itemId = String(d.itemId ?? '');
      const url = String(d.url ?? '');
      if (itemId && url && pickerReq.current.has(itemId)) pickerFull.current[itemId] = url;
      return;
    }

    // Chat-history browsing (B) — not gated by awaitingDesktopRef.
    if (msg.action === 'chat_sessions') {
      setSessions((d.sessions as ChatSession[]) ?? []);
      return;
    }
    if (msg.action === 'chat_session_messages') {
      const arr = (d.messages as { role: string; text: string; thinking: string }[]) ?? [];
      setMessages(arr.map((m) => ({
        id: uid(),
        role: m.role === 'user' ? 'user' : 'assistant',
        text: m.text || '',
        thinking: m.thinking || '',
        sources: [], tools: [], picker: [], streaming: false,
      })));
      setHistoryOpen(false);
      return;
    }

    if (!awaitingDesktopRef.current) return;
    switch (msg.action) {
      case 'agent_question':
        // Agent blocked on ask_user_question — render the choices so the user
        // can answer here; the answer routes back over the relay.
        updateLast((m) => ({
          ...m,
          question: { questionId: String(d.questionId ?? ''), questions: (d.questions as QItem[]) ?? [] },
        }));
        break;
      case 'agent_stream_chunk':
        // Any forward progress means the question (if any) was answered.
        updateLast((m) => ({ ...m, text: m.text + String(d.chunk ?? ''), question: undefined }));
        break;
      case 'agent_thinking':
        updateLast((m) => ({ ...m, thinking: m.thinking + String(d.chunk ?? ''), question: undefined }));
        break;
      case 'tool_call_started':
        updateLast((m) => ({ ...m, tools: [...m.tools, { name: String(d.tool ?? '工具'), status: 'running' }], question: undefined }));
        break;
      case 'tool_call_progress': {
        // Live sub-step breakdown inside a long-running tool (find_references
        // etc.) — surface the active step as the running row's summary so the
        // spinner doesn't read as a hang.
        const tool = String(d.tool ?? '');
        const steps = (d.steps ?? {}) as { title?: string; steps?: { name: string; status: string }[] };
        const list = steps.steps ?? [];
        const active = list.find((s) => s.status === 'running') ?? list[list.length - 1];
        const label = active?.name || steps.title || '';
        if (label) {
          updateLast((m) => {
            const tools = [...m.tools];
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].name === tool && tools[i].status === 'running') {
                tools[i] = { ...tools[i], summary: label };
                break;
              }
            }
            return { ...m, tools };
          });
        }
        break;
      }
      case 'tool_call_finished': {
        const tool = String(d.tool ?? '');
        const success = d.success !== false;
        const resultStr = String(d.result ?? '');
        // Mark the most recent running tool of this name done + summarise.
        updateLast((m) => {
          const tools = [...m.tools];
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i].name === tool && tools[i].status === 'running') {
              tools[i] = { ...tools[i], status: success ? 'ok' : 'fail', summary: summariseToolResult(resultStr) };
              break;
            }
          }
          return { ...m, tools };
        });
        // Any tool can embed a <!--PICKER:...--> image set in its result
        // (show_reference_picker, find_references, browser flows) — mirror the
        // desktop bridge, which scans every tool result for the marker.
        if (success && resultStr.includes('<!--PICKER:')) {
          const imgs = parsePickerImages(resultStr);
          if (imgs.length) {
            updateLast((m) => ({ ...m, picker: [...m.picker, ...imgs] }));
            for (const im of imgs) {
              if (im.eagleId && !pickerReq.current.has(im.eagleId)) {
                pickerReq.current.add(im.eagleId);
                remoteWS.requestThumbnail(im.eagleId);
              }
            }
          }
        }
        break;
      }
      case 'agent_result':
        awaitingDesktopRef.current = false;
        updateLast((m) => ({
          ...m,
          text: m.text || String(d.message ?? ''),
          streaming: false,
          // Finalize any tool whose finished event never arrived (or was
          // dropped on the relay) so the row doesn't spin forever post-turn.
          tools: m.tools.map((t) => (t.status === 'running' ? { ...t, status: 'ok' as const } : t)),
        }));
        setStreaming(false);
        analytics.capture('assistant_response', { mode: 'max_desktop', latency_ms: Date.now() - desktopT0Ref.current });
        break;
      case 'agent_error':
        awaitingDesktopRef.current = false;
        updateLast((m) => ({
          ...m,
          streaming: false,
          text: m.text || `⚠ ${String(d.error ?? '桌面 agent 出错')}`,
          tools: m.tools.map((t) => (t.status === 'running' ? { ...t, status: 'fail' as const } : t)),
        }));
        setStreaming(false);
        analytics.capture('assistant_error', { mode: 'max_desktop', latency_ms: Date.now() - desktopT0Ref.current, message: String(d.error ?? '').slice(0, 80) });
        break;
    }
  }), [updateLast]);

  // Open the picker images in the shared lightbox, starting at `idx`. Eagle
  // items use relay-fetched pixels (thumb now, full swapped lazily); http
  // images load their large URL directly.
  // Lightweight toast for save feedback (auto-clears after 2s).
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2000);
  }, []);

  // Save a picker image into the desktop Eagle library via the relay. Eagle-
  // origin images are already in the library — skip with a note.
  const saveToEagle = useCallback((im?: PickerImage) => {
    if (!im) return;
    if (im.eagleId) { showToast('已在素材库中'); return; }
    const url = im.srcLarge || im.src;
    if (!url) { showToast('此图无法保存'); return; }
    const ok = remoteWS.importFiles([url], { tags: ['参考'], names: im.name ? [im.name] : [] });
    showToast(ok ? '已发送到桌面入库' : '桌面未连接');
  }, [showToast]);

  const openPicker = useCallback((images: PickerImage[], idx: number) => {
    const lbImages: LbImageSource[] = images.map((im) => {
      const dims = im.width && im.height ? { width: im.width, height: im.height } : null;
      const thumbUri = im.eagleId ? (pickerThumbs[im.eagleId] ?? '') : (im.src ?? '');
      const fullUri = im.eagleId
        ? (pickerFull.current[im.eagleId] ?? thumbUri)
        : (im.srcLarge ?? im.src ?? '');
      return {
        id: im.key, uri: fullUri, dimensions: dims,
        thumbUri, thumbDimensions: dims, thumbRect: null, thumbRef: null, thumbBorderRadius: 10,
      };
    });
    openLightboxControl({
      images: lbImages,
      index: idx,
      actions: standardImageActions([
        { key: 'eagle', label: '保存到 Eagle', onPress: (lb) => saveToEagle(images.find((im) => im.key === lb.id)) },
      ]),
    });
    const tgt = images[idx];
    if (tgt?.eagleId && !pickerFull.current[tgt.eagleId]) remoteWS.requestFullImage(tgt.eagleId);
  }, [pickerThumbs, openLightboxControl, saveToEagle]);

  // Send an ask_user_question answer back to the desktop agent and drop the
  // card (the agent resumes and streams its next output).
  const answerQuestion = useCallback((questionId: string, answers: Record<string, string | string[]>) => {
    remoteWS.answerQuestion(questionId, answers);
    updateLast((m) => ({ ...m, question: undefined }));
  }, [updateLast]);

  const openSource = useCallback((uri: string) => {
    import('react-native').then(({ Linking }) => Linking.openURL(uri).catch(() => {}));
  }, []);

  const send = useCallback((preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || streaming) return;

    const priorTurns: ChatTurn[] = messages.map((m) => ({ role: m.role, content: m.text }));
    const history: ChatTurn[] = [...priorTurns, { role: 'user' as const, content: text }];
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', text, thinking: '', sources: [], tools: [], picker: [], streaming: false },
      { id: uid(), role: 'assistant', text: '', thinking: '', sources: [], tools: [], picker: [], streaming: true },
    ]);
    setInput('');
    setStreaming(true);
    const t0 = Date.now();

    // Desktop online → auto-route to its full Cloud MAX agent over the relay
    // (local library / files / references / run_python), running the picked
    // tier; events come back via the onMessage subscription. Offline → cloud.
    if (desktopOnline) {
      analytics.capture('assistant_message', { turn: history.length, mode: `desktop_${tier}` });
      awaitingDesktopRef.current = true;
      desktopT0Ref.current = t0;
      const ok = remoteWS.sendAgent(text, { deepThink: false, history: priorTurns, modelTier: tier });
      if (!ok) {
        awaitingDesktopRef.current = false;
        updateLast((m) => ({ ...m, streaming: false, text: '⚠ 桌面连接已断开，请重试' }));
        setStreaming(false);
      }
      return;
    }

    const mode = tier;
    analytics.capture('assistant_message', { turn: history.length, mode });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void streamAssistant(history, tier, ctrl.signal, {
      onText: (d) => updateLast((m) => ({ ...m, text: m.text + d })),
      onThinking: (d) => updateLast((m) => ({ ...m, thinking: m.thinking + d })),
      onSources: (s) => updateLast((m) => ({ ...m, sources: [...m.sources, ...s] })),
      onStamina: (cost) => {
        if (cost > 0) updateLast((m) => ({ ...m, stamina: cost }));
      },
      // Server-side tool loop: render a live tool row (running → done), same as
      // the desktop-relay path's tool_call_started/finished.
      onTool: (name, status) => updateLast((m) => {
        if (status === 'running') return { ...m, tools: [...m.tools, { name, status: 'running' as const }] };
        const tools = [...m.tools];
        for (let i = tools.length - 1; i >= 0; i--) {
          if (tools[i].name === name && tools[i].status === 'running') { tools[i] = { ...tools[i], status: 'ok' }; break; }
        }
        return { ...m, tools };
      }),
      onDone: () => {
        // Flush any tool row still 'running' (e.g. a server-side tool that errored
        // never sent its 'done' event) so the spinner doesn't spin forever.
        updateLast((m) => ({
          ...m,
          streaming: false,
          tools: m.tools.map((t) => (t.status === 'running' ? { ...t, status: 'fail' as const } : t)),
        }));
        setStreaming(false); abortRef.current = null;
        analytics.capture('assistant_response', { mode, latency_ms: Date.now() - t0 });
      },
      onError: (msg) => {
        updateLast((m) => ({ ...m, streaming: false, text: m.text || `⚠ ${msg}`, tools: m.tools.map((t) => (t.status === 'running' ? { ...t, status: 'fail' as const } : t)) }));
        setStreaming(false); abortRef.current = null;
        analytics.capture('assistant_error', { mode, latency_ms: Date.now() - t0, message: String(msg).slice(0, 80) });
      },
    });
  }, [input, streaming, messages, tier, desktopOnline, updateLast]);

  const stop = useCallback(() => {
    if (awaitingDesktopRef.current) {
      awaitingDesktopRef.current = false;
      remoteWS.abortAgent();
      updateLast((m) => markInterrupted(m, m.text || '已停止'));
      setStreaming(false);
      return;
    }
    abortRef.current?.abort();
  }, [updateLast]);

  const empty = messages.length === 0;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      <XStack paddingHorizontal={16} paddingTop={12} paddingBottom={8} alignItems="center" gap={8}>
        <Text flex={1} color={colors.text.primary} fontSize={22} fontWeight="700">助手</Text>

        {/* New chat — clears the view for a fresh session. */}
        <Pressable testID="new-chat" hitSlop={6} onPress={() => { setMessages([]); setHistoryOpen(false); }}>
          <Plus size={20} color={colors.text.secondary} />
        </Pressable>
        {/* History — browse desktop chat sessions. */}
        <Pressable testID="history-open" hitSlop={6} onPress={() => { remoteWS.requestChatSessions(); setHistoryOpen(true); }}>
          <History size={20} color={colors.text.secondary} />
        </Pressable>

        {/* Desktop presence lives here (out of the composer): online → the 桌面
            chip in the composer can route to the full agent; offline → cloud
            tiers only. */}
        <XStack testID="desktop-status"
          backgroundColor={desktopOnline ? 'rgba(126,200,217,0.10)' : 'rgba(255,255,255,0.04)'}
          borderColor={desktopOnline ? 'rgba(126,200,217,0.28)' : colors.border.default} borderWidth={1}
          borderRadius={13} paddingHorizontal={10} height={26} alignItems="center" gap={5}>
          <Monitor size={12} color={desktopOnline ? colors.status.success : colors.text.muted} />
          <Text color={desktopOnline ? colors.status.success : colors.text.tertiary} fontSize={12}>
            {desktopOnline ? '桌面在线' : '桌面离线'}
          </Text>
        </XStack>
      </XStack>

      <YStack flex={1} paddingBottom={kbVisible ? kbHeight : 0}>
        {empty ? (
          <YStack flex={1} justifyContent="center" paddingHorizontal={20}>
            <GlassCard style={{ alignItems: 'center', gap: 14 }}>
              <YStack width={64} height={64} borderRadius={32} justifyContent="center" alignItems="center"
                backgroundColor="rgba(206,172,224,0.12)" borderWidth={1} borderColor="rgba(206,172,224,0.22)">
                <Sparkles size={28} color={colors.brand.primary} />
              </YStack>
              <Text color={colors.text.primary} fontSize={16} fontWeight="700">问点什么</Text>
              <Text color={colors.text.tertiary} fontSize={13} textAlign="center" lineHeight={19}>
                联网搜索 · 创作问答，随身可用
              </Text>
              <YStack gap={8} width="100%" marginTop={4}>
                {SUGGESTIONS.map((s) => (
                  <Pressable key={s} onPress={() => send(s)}>
                    <XStack borderColor={colors.border.default} borderWidth={1} borderRadius={14}
                      paddingHorizontal={14} paddingVertical={11} alignItems="center" gap={8}>
                      <Text flex={1} color={colors.text.secondary} fontSize={13}>{s}</Text>
                      <ChevronRight size={15} color={colors.text.faint} />
                    </XStack>
                  </Pressable>
                ))}
              </YStack>
            </GlassCard>
          </YStack>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={{ paddingTop: 4, paddingBottom: 12 }}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {messages.map((m) => (
              <MessageRow key={m.id} msg={m} onSource={openSource}
                pickerThumbs={pickerThumbs} onOpenPicker={openPicker} onAnswerQuestion={answerQuestion} />
            ))}
          </ScrollView>
        )}

        {toastMsg ? (
          <YStack position="absolute" bottom={120} left={0} right={0} alignItems="center" zIndex={100} pointerEvents="none">
            <YStack backgroundColor="rgba(0,0,0,0.82)" borderRadius={20} paddingHorizontal={16} paddingVertical={9}>
              <Text color="#fff" fontSize={13}>{toastMsg}</Text>
            </YStack>
          </YStack>
        ) : null}

        {/* Composer — desktop input-box pattern (HomeView.qml): recessed-glass box
            with text on top + a bottom toolbar (MAX toggle left, send right). */}
        <YStack paddingHorizontal={12} paddingTop={10} paddingBottom={composerPad}
          backgroundColor={colors.bg.canvas} borderTopWidth={1} borderColor={colors.border.subtle}>
          <YStack borderRadius={18} overflow="hidden" borderWidth={1}
            borderColor={inputFocused ? colors.brand.primary : colors.border.default}>
            <LinearGradient colors={['#2A2546', '#221D3C']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFill} />

            <TextInput
              testID="composer-input"
              value={input}
              onChangeText={setInput}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder="问 Nephele…"
              placeholderTextColor={colors.text.muted}
              multiline
              style={{ color: colors.text.primary, fontSize: 15, minHeight: 24, maxHeight: 120, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 2 }}
            />

            {/* Bottom toolbar — model-tier segmented control + send. */}
            <XStack paddingHorizontal={10} paddingBottom={8} paddingTop={4} alignItems="center" gap={8}>
              {/* Engine picker: Zephyr (cheap) / Tempest (full power). Honored
                  end-to-end on both routes — cloud when the desktop is offline,
                  the desktop's full agent on that same tier when it's online
                  (auto-routed; presence shown by the header pill). */}
              <XStack borderRadius={9} borderWidth={1} borderColor={colors.border.default} overflow="hidden">
                {(['zephyr', 'tempest'] as const).map((t) => {
                  const on = tier === t;
                  return (
                    <Pressable key={t} testID={`tier-${t}`} accessibilityState={{ selected: on }}
                      onPress={() => setTier(t)} hitSlop={4}>
                      <XStack height={26} paddingHorizontal={11} alignItems="center" gap={4}
                        backgroundColor={on ? 'rgba(206,172,224,0.16)' : 'transparent'}>
                        <Zap size={11} color={on ? colors.brand.primary : colors.text.tertiary}
                          fill={on ? colors.brand.primary : 'transparent'} />
                        <Text fontSize={12} fontWeight={on ? '700' : '500'} letterSpacing={0.3}
                          color={on ? colors.brand.primary : colors.text.tertiary}>
                          {t === 'zephyr' ? 'Zephyr' : 'Tempest'}
                        </Text>
                      </XStack>
                    </Pressable>
                  );
                })}
              </XStack>
              <YStack flex={1} />
              <Pressable testID="composer-send" accessibilityLabel={streaming ? 'stop' : 'send'}
                onPress={() => (streaming ? stop() : send())} disabled={!streaming && !input.trim()}>
                <YStack width={34} height={34} borderRadius={17} justifyContent="center" alignItems="center"
                  backgroundColor={streaming ? colors.bg.surface : (input.trim() ? colors.brand.primary : colors.bg.surface)}
                  borderWidth={streaming || !input.trim() ? 1 : 0} borderColor={colors.border.default}
                  style={!streaming && input.trim() ? composerStyles.sendLift : undefined}>
                  {streaming
                    ? <Square size={13} color={colors.text.secondary} fill={colors.text.secondary} />
                    : <ArrowUp size={18} color={input.trim() ? colors.bg.canvas : colors.text.muted} />}
                </YStack>
              </Pressable>
            </XStack>
          </YStack>
        </YStack>
      </YStack>

      {/* Desktop chat-history browser (B) — tap a session to load its
          transcript into the view. Read-only history; new sends start/continue
          the desktop's current session. */}
      {historyOpen && (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setHistoryOpen(false)}>
          <YStack position="absolute" top={56} left={12} right={12} bottom={40}
            backgroundColor={colors.bg.surface} borderRadius={16} borderWidth={1}
            borderColor={colors.border.default} overflow="hidden">
            <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center"
              borderBottomWidth={1} borderColor={colors.border.subtle}>
              <Text flex={1} color={colors.text.primary} fontSize={15} fontWeight="700">历史会话</Text>
              <Pressable hitSlop={8} onPress={() => setHistoryOpen(false)}>
                <XIcon size={18} color={colors.text.tertiary} />
              </Pressable>
            </XStack>
            <ScrollView showsVerticalScrollIndicator={false}>
              {sessions.length === 0 ? (
                <Text color={colors.text.tertiary} fontSize={13} padding={20} textAlign="center">
                  暂无会话(或桌面未连接)
                </Text>
              ) : sessions.map((s) => (
                <Pressable key={s.id} testID={`session-${s.id}`} onPress={() => remoteWS.loadChatSession(s.id)}>
                  <XStack paddingHorizontal={16} paddingVertical={13} gap={10} alignItems="center"
                    borderBottomWidth={1} borderColor={colors.border.subtle}>
                    <YStack flex={1}>
                      <Text color={colors.text.primary} fontSize={14} numberOfLines={1}>{s.title}</Text>
                      <Text color={colors.text.faint} fontSize={11} marginTop={2}>
                        {String(s.updatedAt).slice(0, 16).replace('T', ' ')}{s.count ? ` · ${s.count} 条` : ''}
                      </Text>
                    </YStack>
                    <ChevronRight size={15} color={colors.text.faint} />
                  </XStack>
                </Pressable>
              ))}
            </ScrollView>
          </YStack>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

const composerStyles = StyleSheet.create({
  // Soft brand-purple glow under the active send button — same lift as AuraButton.
  sendLift: Platform.select({
    ios: { shadowColor: '#CEACE0', shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    android: { elevation: 8 },
  })!,
});
