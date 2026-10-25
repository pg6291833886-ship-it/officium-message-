import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Hash,
  Home,
  Lock,
  Menu,
  MessageSquare,
  Plug,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  Smile,
  Star,
  Users,
  Workflow,
} from "lucide-react";
import { UserButton } from "@/lib/auth/gates";
import { isAdmin, isStaff, navAllowed } from "@/lib/message/access";
import { searchEmojis } from "@/lib/message/emoji";
import {
  analytics,
  bootstrap,
  changeMessage,
  createChannel,
  createGroup,
  createInvite,
  deleteWorkflow,
  duplicateWorkflow,
  fileData,
  listAudit,
  listFiles,
  markNotificationsRead,
  markRead,
  openDm,
  olderMessages,
  prepareUpload,
  pulse,
  redeemInvite,
  relocateFiles,
  saveBot,
  saveTask,
  saveWorkflow,
  searchAll,
  sendMessage,
  setAiSettings,
  setConversationFlags,
  setRole,
  setTyping,
  setWorkflowEnabled,
  approveDraft,
  rejectDraft,
  registerTelegramHook,
  testIntegration,
  testWorkflow,
  updateProfile,
  updateThread,
} from "@/lib/message/api";

type View =
  | "inbox"
  | "dms"
  | "channels"
  | "activity"
  | "automations"
  | "bots"
  | "integrations"
  | "files"
  | "analytics"
  | "members"
  | "settings"
  | "admin";

type Focus = { kind: "channel" | "conversation"; id: string };

const NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: "inbox", label: "Home", icon: Home },
  { id: "dms", label: "DMs", icon: MessageSquare },
  { id: "activity", label: "Activity", icon: Bell },
  { id: "channels", label: "Channels", icon: Hash },
  { id: "automations", label: "Flows", icon: Workflow },
  { id: "bots", label: "Bots", icon: Bot },
  { id: "integrations", label: "Apps", icon: Plug },
  { id: "files", label: "Files", icon: FileText },
  { id: "analytics", label: "Stats", icon: BarChart3 },
  { id: "members", label: "Team", icon: Users },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "admin", label: "Admin", icon: Shield },
];

const PRIMARY = new Set<View>(["inbox", "dms", "activity"]);
const STAR_KEY = "officium-message-stars";
const THEME_KEY = "officium-message-theme";

const REACTIONS = ["👍", "✅", "❓", "👀"] as const;

function timeLabel(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : "Something went wrong.";
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (start(today) - start(d)) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function EmojiPicker({ onPick }: { onPick: (char: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchEmojis(query), [query]);
  return (
    <div className="emoji-pop">
      <button
        type="button"
        className="btn ghost icon-btn"
        aria-label="Insert emoji"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Smile size={18} />
      </button>
      {open ? (
        <div className="emoji-panel" role="dialog" aria-label="Emoji picker">
          <input
            className="field"
            placeholder="Search emoji"
            aria-label="Search emoji"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="emoji-grid">
            {hits.length === 0 ? <p className="text-xs text-muted">No emoji matches that search.</p> : hits.map((emoji) => (
              <button
                key={emoji.char + emoji.name}
                type="button"
                className="emoji-btn"
                aria-label={emoji.name}
                onClick={() => onPick(emoji.char)}
              >
                {emoji.char}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const imagePreview = new Map<string, string>();

function AttachmentView({
  id, name, inline, onError,
}: {
  id: string;
  name: string;
  inline: string;
  onError: (s: string) => void;
}) {
  const image = /\.(png|jpe?g|gif|webp)$/i.test(name) || inline.startsWith("data:image/");
  const [src, setSrc] = useState(inline.startsWith("data:image/") ? inline : (imagePreview.get(id) ?? ""));
  useEffect(() => {
    if (!image || src) return;
    let gone = false;
    void fileData({ data: { id } }).then((r) => {
      if (gone || !r.ok) return;
      if (r.data.startsWith("data:image/") || r.data.startsWith("https://") || r.data.startsWith("http://")) {
        imagePreview.set(id, r.data);
        setSrc(r.data);
      }
    });
    return () => { gone = true; };
  }, [id, image, src]);
  if (image && src) return <img src={src} alt={name || "Shared image"} className="mt-1 max-h-48 rounded-lg" />;
  if (!name) return null;
  return (
    <button type="button" className="mt-1 text-xs text-accent underline" onClick={() => void fileData({ data: { id } }).then((r) => {
      if (!r.ok) { onError(r.error); return; }
      const a = document.createElement("a");
      a.href = r.data;
      a.download = name;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.click();
    })}>{name}</button>
  );
}

function loadStars() {
  try {
    const raw = localStorage.getItem(STAR_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function Workspace() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("channels");
  const [focus, setFocus] = useState<Focus | null>({ kind: "channel", id: "ch_general" });
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [notice, setNotice] = useState("");
  const [q, setQ] = useState("");
  const [searchHits, setSearchHits] = useState<Awaited<ReturnType<typeof searchAll>> | null>(null);
  const [composerError, setComposerError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [pendingFile, setPendingFile] = useState<{ name: string; data?: string; file?: File } | null>(null);
  const [stars, setStars] = useState<string[]>([]);
  const [sections, setSections] = useState({ starred: true, channels: true, dms: true, more: false });
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [older, setOlder] = useState<NonNullable<Awaited<ReturnType<typeof pulse>>["messages"]>>([]);
  const [olderDone, setOlderDone] = useState(false);
  const [pendingMsgs, setPendingMsgs] = useState<{ id: string; focusKey: string; body: string; attachmentName: string; attachmentData: string }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const typingAt = useRef(0);

  const boot = useQuery({
    queryKey: ["boot"],
    queryFn: () => bootstrap(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const live = useQuery({
    queryKey: ["pulse", focus?.kind ?? "", focus?.id ?? ""],
    queryFn: () => pulse({ data: focus ? { kind: focus.kind, id: focus.id } : {} }),
    enabled: Boolean(boot.data),
    refetchInterval: 4000,
    refetchOnWindowFocus: false,
  });

  const messaging = view === "inbox" || view === "dms" || view === "channels";
  const channels = live.data?.channels ?? boot.data?.channels ?? [];
  const conversations = live.data?.conversations ?? boot.data?.conversations ?? [];
  const liveMessages = live.data?.messages ?? [];
  const liveIds = new Set(liveMessages.map((m) => m.id));
  const messages = [...older.filter((m) => !liveIds.has(m.id)), ...liveMessages];
  const detail = live.data?.detail;

  useEffect(() => {
    if (!focus) return;
    void markRead({ data: focus }).catch(() => undefined);
  }, [focus?.kind, focus?.id]);

  useEffect(() => {
    setOlder([]);
    setOlderDone(false);
    setEditingId("");
  }, [focus?.kind, focus?.id]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setSearchHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchAll({ data: { q: q.trim() } }).then(setSearchHits).catch((e) => setNotice(errText(e)));
    }, 400);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setStars(loadStars());
    const saved = localStorage.getItem(THEME_KEY);
    const next = saved === "dark" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next === "dark" ? "dark" : "";
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, focus?.id]);

  useEffect(() => {
    const fired = live.data?.firedReminders ?? [];
    if (fired.length) setNotice(`Reminder: ${fired[0]}`);
  }, [live.data?.firedReminders]);

  const title = useMemo(() => {
    if (!focus) return "Officium Message";
    if (focus.kind === "channel") return channels.find((c) => c.id === focus.id)?.name ?? "Channel";
    return conversations.find((c) => c.id === focus.id)?.name ?? "Conversation";
  }, [focus, channels, conversations]);

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["boot"] }),
      qc.invalidateQueries({ queryKey: ["pulse"] }),
    ]);
  }

  async function refreshThread() {
    await qc.invalidateQueries({ queryKey: ["pulse"] });
  }

  async function onSend() {
    if (!focus) return;
    setComposerError("");
    if (editingId) {
      try {
        const res = await changeMessage({ data: { id: editingId, action: "edit", body: draft } });
        if (!res.ok) {
          setComposerError(res.error);
          return;
        }
        setEditingId("");
        setDraft("");
        await refreshThread();
      } catch (e) {
        setComposerError(errText(e));
      }
      return;
    }
    const text = draft;
    const file = pendingFile;
    const localId = `local-${Date.now()}`;
    const focusKey = `${focus.kind}:${focus.id}`;
    setDraft("");
    setPendingFile(null);
    setReplyTo("");
    setPendingMsgs((cur) => [...cur, {
      id: localId,
      focusKey,
      body: text || (file ? `Sending ${file.name}` : ""),
      attachmentName: file?.name ?? "",
      attachmentData: file?.data ?? "",
    }]);
    try {
      let attachmentData = file?.data;
      let attachmentFileId: string | undefined;
      if (file?.file) {
        let uploaded = false;
        try {
          const prepared = await prepareUpload({
            data: {
              kind: focus.kind,
              id: focus.id,
              name: file.name,
              contentType: file.file.type,
              size: file.file.size,
            },
          });
          if (prepared.ok) {
            try {
              const put = await fetch(prepared.uploadUrl, { method: "PUT", headers: prepared.headers, body: file.file, signal: AbortSignal.timeout(8000) });
              uploaded = put.ok;
              if (uploaded) attachmentFileId = prepared.fileId;
            } catch {
              uploaded = false;
            }
          }
        } catch {
          uploaded = false;
        }
        if (!uploaded) {
          const blob = file.file;
          if (blob && blob.type.startsWith("image/") && blob.size <= 1_500_000) {
            attachmentData = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ""));
              reader.onerror = () => reject(new Error("Could not read the image."));
              reader.readAsDataURL(blob);
            });
          } else {
            setPendingMsgs((cur) => cur.filter((p) => p.id !== localId));
            setDraft(text);
            setPendingFile(file);
            setComposerError("Cloudflare R2 rejected this file. Images under 1.5 MB are saved in the workspace instead, but this file is larger or is not an image. The saved R2 secret in Vercel is still the old one.");
            return;
          }
        }
      }
      const res = await sendMessage({
        data: {
          kind: focus.kind,
          id: focus.id,
          body: text,
          replyToId: replyTo || undefined,
          attachmentName: file?.name,
          attachmentData,
          attachmentFileId,
        },
      });
      if (!res.ok) {
        setPendingMsgs((cur) => cur.filter((p) => p.id !== localId));
        setDraft(text);
        setPendingFile(file);
        setComposerError(res.error);
        return;
      }
      await refreshThread();
    } catch (e) {
      setPendingMsgs((cur) => cur.filter((p) => p.id !== localId));
      setDraft(text);
      setPendingFile(file);
      setComposerError(errText(e));
    }
  }

  function insertEmoji(char: string) {
    const el = draftRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = `${draft.slice(0, start)}${char}${draft.slice(end)}`;
    setDraft(next);
    const caret = start + char.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function runSearch(value: string) {
    setQ(value);
  }

  function openFocus(next: Focus) {
    setFocus(next);
    setView(next.kind === "channel" ? "channels" : "dms");
    setDrawer(false);
    setSearchHits(null);
  }

  if (boot.isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper">
        <p className="text-muted">Opening the Officium Connect workspace…</p>
      </main>
    );
  }
  if (boot.isError || !boot.data) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper px-6">
        <div className="card max-w-md">
          <p className="font-serif text-2xl">Could not open the workspace</p>
          <p className="mt-2 text-sm text-muted">{boot.error ? errText(boot.error) : "Try signing in again."}</p>
        </div>
      </main>
    );
  }

  const data = boot.data;
  const activityCount = live.data?.unreadNotifications ?? data.unreadNotifications;
  const pane = !messaging ? "tool" : focus ? "thread" : "list";
  const shellClass = ["shell", messaging && drawer && detail ? "with-drawer" : ""].filter(Boolean).join(" ");
  const starredChannels = channels.filter((c) => stars.includes(c.id));
  const starredDms = conversations.filter((c) => stars.includes(c.id));
  const focusKey = focus ? `${focus.kind}:${focus.id}` : "";
  const shown = [
    ...messages,
    ...pendingMsgs.filter((p) => p.focusKey === focusKey && !messages.some((m) => m.mine && m.body === p.body && (m.attachmentName || "") === p.attachmentName)).map((p) => ({
      id: p.id,
      body: p.body,
      authorId: data.me.id,
      authorName: data.me.name,
      mine: true,
      createdAt: new Date().toISOString(),
      editedAt: "",
      deleted: false,
      pinned: false,
      replyToId: "",
      attachmentName: p.attachmentName,
      attachmentData: p.attachmentData,
      attachmentFileId: "",
      read: false,
      reactions: [] as { userId: string; emoji: string }[],
      pending: true as const,
    })),
  ];

  function toggleStar(id: string) {
    setStars((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      localStorage.setItem(STAR_KEY, JSON.stringify(next));
      return next;
    });
  }

  function go(next: View) {
    if (!navAllowed(next, data.me.role)) return;
    setView(next);
    setSearchHits(null);
    if (next === "activity" || next === "members" || next === "settings" || next === "admin") {
      void qc.invalidateQueries({ queryKey: ["boot"] });
    }
    if (next !== "inbox" && next !== "dms" && next !== "channels") setFocus(null);
    else if (window.matchMedia("(max-width: 767px)").matches) setFocus(null);
  }

  function row(item: { id: string; name: string; unread: number; kind: "channel" | "conversation"; visibility?: string }) {
    const on = focus?.kind === item.kind && focus.id === item.id;
    return (
      <div key={`${item.kind}-${item.id}`} className="nav-row" data-on={on}>
        <button type="button" className="nav-row-main" onClick={() => openFocus({ kind: item.kind, id: item.id })}>
          {item.kind === "channel"
            ? (item.visibility === "private" ? <Lock size={16} /> : <Hash size={16} />)
            : <span className="grid h-5 w-5 place-items-center rounded bg-white/10 text-[11px] font-semibold">{item.name.slice(0, 1).toUpperCase()}</span>}
          <span>{item.name}</span>
          {item.unread ? <em className="badge">{item.unread}</em> : null}
        </button>
        <button type="button" className="nav-star" data-on={stars.includes(item.id)} aria-label={stars.includes(item.id) ? `Unstar ${item.name}` : `Star ${item.name}`} aria-pressed={stars.includes(item.id)} onClick={() => toggleStar(item.id)}>
          <Star size={14} fill={stars.includes(item.id) ? "currentColor" : "none"} />
        </button>
      </div>
    );
  }

  const messageBlocks: ReactNode[] = [];
  let lastDay = "";
  for (const m of shown) {
    const day = dayLabel(m.createdAt);
    if (day && day !== lastDay) {
      lastDay = day;
      messageBlocks.push(<div key={`day-${m.id}`} className="day-sep">{day}</div>);
    }
    const initials = m.authorName.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
    messageBlocks.push(
      <article key={m.id} className={`msg${m.deleted ? " deleted" : ""}`}>
        <div className="avatar" aria-hidden="true">{initials}</div>
        <div className="min-w-0">
          <p className="msg-meta">
            <strong>{m.authorName}</strong>
            <time dateTime={m.createdAt}>{timeLabel(m.createdAt)}</time>
            {m.editedAt ? <span>edited</span> : null}
            {m.mine ? <span>{m.read ? "read" : "sent"}</span> : null}
            {m.mine && "pending" in m ? <span>sending</span> : null}
            {m.pinned ? <span>pinned</span> : null}
          </p>
          {m.replyToId ? <p className="text-xs text-muted">Reply</p> : null}
          <p className="msg-body">{m.body}</p>
          {m.attachmentName || m.attachmentData ? (
            <AttachmentView id={m.id} name={m.attachmentName} inline={m.attachmentData} onError={setComposerError} />
          ) : null}
          {m.reactions.length ? (
            <div>
              {Array.from(m.reactions.reduce((map, r) => map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1), new Map<string, number>())).map(([emoji, count]) => (
                <button key={emoji} type="button" className="react-chip" onClick={() => void changeMessage({ data: { id: m.id, action: "react", emoji } }).then((r) => { if (!r.ok) setComposerError(r.error); return refreshThread(); })}>{emoji} {count}</button>
              ))}
            </div>
          ) : null}
          {!m.deleted && !("pending" in m) ? (
            <div className="msg-actions">
              <button type="button" className="btn tiny ghost" onClick={() => setReplyTo(m.id)}>Reply</button>
              <button type="button" className="btn tiny ghost" onClick={() => void changeMessage({ data: { id: m.id, action: "pin" } }).then((r) => { if (!r.ok) setComposerError(r.error); return refreshThread(); })}>Pin</button>
              {REACTIONS.map((emoji) => (
                <button key={emoji} type="button" className="btn tiny ghost" onClick={() => void changeMessage({ data: { id: m.id, action: "react", emoji } }).then((r) => { if (!r.ok) setComposerError(r.error); return refreshThread(); })}>{emoji}</button>
              ))}
              {m.mine ? (
                <button type="button" className="btn tiny ghost" onClick={() => {
                  setEditingId(m.id);
                  setDraft(m.body);
                  setReplyTo("");
                  setComposerError("");
                  requestAnimationFrame(() => draftRef.current?.focus());
                }}>Edit</button>
              ) : null}
              {m.mine ? <button type="button" className="btn tiny ghost" onClick={() => void changeMessage({ data: { id: m.id, action: "delete" } }).then((r) => { if (!r.ok) setComposerError(r.error); return refreshThread(); })}>Delete</button> : null}
            </div>
          ) : null}
        </div>
      </article>,
    );
  }

  return (
    <div className={shellClass} data-pane={pane}>
      <header className="topbar">
        {pane === "thread" ? (
          <button type="button" className="icon-btn btn ghost" style={{ color: "inherit", borderColor: "#2a4266" }} onClick={() => setFocus(null)} aria-label="Back to conversations">
            <ArrowLeft size={18} />
          </button>
        ) : (
          <img src="/officium-mark.png" alt="" />
        )}
        <div className="grow min-w-0">
          {pane === "thread" ? <h1 className="truncate">{focus?.kind === "channel" ? `#${title}` : title}</h1> : null}
        </div>
        <button type="button" className="icon-btn" style={{ background: "transparent", color: "inherit" }} aria-label="Search" onClick={() => { setFocus(null); setView("inbox"); }}>
          <Search size={18} />
        </button>
        {pane === "thread" ? <button type="button" className="btn tiny ghost" style={{ color: "inherit", borderColor: "#2a4266" }} onClick={() => setDrawer((v) => !v)}>Details</button> : <UserButton />}
      </header>

      <aside className="sidebar" aria-label="Workspace">
        <div className="brand-row">
          <img src="/officium-mark.png" alt="Officium Connect" />
          <div className="min-w-0">
            <p className="brand-name truncate">{data.workspace.name}</p>
            <p className="brand-sub truncate">{data.me.name} · {data.me.role}</p>
          </div>
        </div>
        <div className="side-search">
          <Search size={16} />
          <input
            placeholder="Search messages and people"
            value={q}
            aria-label="Search messages and people"
            onChange={(e) => void runSearch(e.target.value)}
          />
        </div>
        <div className="side-scroll">
          {NAV.filter((item) => PRIMARY.has(item.id)).map((item) => {
            const Icon = item.icon;
            const badge = item.id === "activity" ? activityCount : 0;
            return (
              <button key={item.id} type="button" className="side-link" data-on={view === item.id && !focus} onClick={() => go(item.id)}>
                <Icon size={18} strokeWidth={1.75} />
                <span>{item.label}</span>
                {badge ? <em className="badge">{badge}</em> : null}
              </button>
            );
          })}
          {searchHits ? (
            <div className="px-3 py-2 text-[13px]">
              <p className="mb-1 font-medium text-[var(--color-side-muted)]">Search</p>
              {searchHits.people.map((p) => (
                <button key={p.user_id} type="button" className="more-link" onClick={() => {
                  void openDm({ data: { userId: p.user_id } }).then(async (r) => {
                    if (r.ok) openFocus({ kind: "conversation", id: r.id });
                    else setNotice(r.error);
                    await refresh();
                  });
                }}>{p.display_name}</button>
              ))}
              {searchHits.messages.map((m) => (
                <button key={m.id} type="button" className="more-link" onClick={() => openFocus(m.channelId ? { kind: "channel", id: m.channelId } : { kind: "conversation", id: m.conversationId })}>
                  <span className="truncate">{m.body}</span>
                </button>
              ))}
              {!searchHits.messages.length && !searchHits.people.length ? <p className="px-2 text-[var(--color-side-muted)]">No matches in threads you can access.</p> : null}
            </div>
          ) : (
            <>
              <button type="button" className="section-toggle" aria-expanded={sections.starred} onClick={() => setSections((s) => ({ ...s, starred: !s.starred }))}>
                {sections.starred ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Starred
              </button>
              {sections.starred ? (
                starredChannels.length + starredDms.length === 0
                  ? <p className="px-4 text-xs text-[var(--color-side-muted)]">Star a channel or conversation to keep it here.</p>
                  : <>
                    {starredChannels.map((c) => row({ ...c, kind: "channel" }))}
                    {starredDms.map((c) => row({ ...c, kind: "conversation" }))}
                  </>
              ) : null}
              <button type="button" className="section-toggle" aria-expanded={sections.channels} onClick={() => setSections((s) => ({ ...s, channels: !s.channels }))}>
                {sections.channels ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Channels
              </button>
              {sections.channels ? (
                <>
                  {channels.map((c) => row({ ...c, kind: "channel" }))}
                  {isStaff(data.me.role) ? <div className="px-3 py-2"><ChannelForm onDone={async (id) => { await refresh(); openFocus({ kind: "channel", id }); }} /></div> : null}
                </>
              ) : null}
              <button type="button" className="section-toggle" aria-expanded={sections.dms} onClick={() => setSections((s) => ({ ...s, dms: !s.dms }))}>
                {sections.dms ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Direct messages
              </button>
              {sections.dms ? (
                <>
                  {conversations.map((c) => row({ ...c, kind: "conversation" }))}
                  {data.me.role !== "guest" ? <div className="px-3 py-2"><GroupForm members={data.members} me={data.me.id} onDone={async (id) => { await refresh(); openFocus({ kind: "conversation", id }); }} /></div> : null}
                </>
              ) : null}
            </>
          )}
          <button type="button" className="section-toggle" aria-expanded={sections.more} onClick={() => setSections((s) => ({ ...s, more: !s.more }))}>
            {sections.more ? <ChevronDown size={14} /> : <ChevronRight size={14} />} More
          </button>
          {sections.more ? NAV.filter((item) => !PRIMARY.has(item.id) && item.id !== "channels" && navAllowed(item.id, data.me.role)).map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className="more-link" data-on={view === item.id} onClick={() => go(item.id)}>
                <Icon size={18} strokeWidth={1.75} />
                <span>{item.label}</span>
              </button>
            );
          }) : null}
        </div>
        <div className="side-foot">
          <UserButton />
          <button type="button" className="theme-toggle" onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            setTheme(next);
            localStorage.setItem(THEME_KEY, next);
            document.documentElement.dataset.theme = next === "dark" ? "dark" : "";
          }}>{theme === "dark" ? "Light" : "Dark"}</button>
        </div>
      </aside>

      {messaging && focus ? (
        <section className="thread">
          <header className="thread-head">
            <div className="min-w-0 flex-1">
              <h1 className="truncate">{focus.kind === "channel" ? `#${title}` : title}</h1>
              <p className="truncate">
                {live.data?.typing?.length ? `${live.data.typing.map((t) => t.name).join(", ")} typing` : "Saved in this workspace. New messages refresh every few seconds."}
              </p>
            </div>
            <button type="button" className="btn ghost tiny" onClick={() => setDrawer((v) => !v)}>Details</button>
          </header>
          <div className="scroll">
            {focus && !olderDone && live.data?.olderAvailable ? (
              <button type="button" className="btn ghost tiny mb-2" onClick={() => {
                const oldest = messages[0]?.createdAt;
                if (!oldest) return;
                void olderMessages({ data: { kind: focus.kind, id: focus.id, before: oldest } }).then((r) => {
                  if (!r.messages.length) setOlderDone(true);
                  else setOlder((cur) => [...r.messages, ...cur]);
                }).catch((e) => setComposerError(errText(e)));
              }}>Load older messages</button>
            ) : null}
            {messages.filter((m) => m.pinned && !m.deleted).map((m) => (
              <p key={`pin-${m.id}`} className="pin-line">Pinned: {m.body.slice(0, 140)}</p>
            ))}
            {messageBlocks}
            <div ref={endRef} />
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); void onSend(); }}>
            {editingId ? <p className="mb-1 text-xs text-muted">Editing your message <button type="button" className="text-accent" onClick={() => { setEditingId(""); setDraft(""); }}>cancel</button></p> : null}
            {replyTo ? <p className="mb-1 text-xs text-muted">Replying <button type="button" className="text-accent" onClick={() => setReplyTo("")}>cancel</button></p> : null}
            {pendingFile ? <p className="mb-1 text-xs">Attached: {pendingFile.name}</p> : null}
            {composerError ? <p className="mb-1 text-sm text-danger">{composerError}</p> : null}
            <div className="composer-box">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const objectStorage = data.ai.storage === "object";
                  const limit = data.ai.maxBytes ?? (objectStorage ? 8_000_000 : 120_000);
                  if (!file.type || !["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"].includes(file.type)) {
                    setComposerError("Use a PNG, JPEG, WebP, GIF, PDF, or plain text file.");
                    return;
                  }
                  if (file.size > limit) {
                    setComposerError(objectStorage
                      ? "File is over the 8 MB limit."
                      : "File is over 120 KB. Cloudflare R2 is not configured, so larger files are not stored in the database.");
                    return;
                  }
                  if (objectStorage) {
                    setPendingFile({ name: file.name, file });
                    setComposerError("");
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => setPendingFile({ name: file.name, data: String(reader.result ?? "") });
                  reader.readAsDataURL(file);
                }}
              />
              <button type="button" className="btn ghost icon-btn" aria-label="Attach file" onClick={() => fileRef.current?.click()}>
                <Plus size={18} />
              </button>
              <EmojiPicker onPick={insertEmoji} />
              <textarea
                ref={draftRef}
                className="field"
                placeholder={editingId ? "Edit your message" : `Message ${focus.kind === "channel" ? `#${title}` : title}`}
                value={draft}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (!focus || editingId) return;
                  const now = Date.now();
                  if (now - typingAt.current < 2000) return;
                  typingAt.current = now;
                  void setTyping({ data: focus }).catch(() => undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
              />
              <button className="btn icon-btn" type="submit" aria-label={editingId ? "Save edit" : "Send"}><Send size={18} /></button>
            </div>
          </form>
        </section>
      ) : (
        <section className="panel">
          <header className="panel-head">
            <div className="min-w-0 flex-1">
              <p>Officium Message</p>
              <h1>{NAV.find((n) => n.id === view)?.label}</h1>
            </div>
            <UserButton />
          </header>
          <div className="scroll">
            {view === "activity" ? <Activity items={data.notifications} onRead={async () => { await markNotificationsRead(); await refresh(); }} /> : null}
            {view === "automations" && isStaff(data.me.role) ? <Automations data={data} onChange={refresh} setNotice={setNotice} /> : null}
            {view === "bots" && isStaff(data.me.role) ? <Bots data={data} onChange={refresh} setNotice={setNotice} /> : null}
            {view === "integrations" && isStaff(data.me.role) ? <Integrations data={data} onChange={refresh} setNotice={setNotice} /> : null}
            {view === "files" ? <Files onError={setNotice} /> : null}
            {view === "analytics" && isStaff(data.me.role) ? <Stats /> : null}
            {view === "members" ? <Members data={data} onChange={refresh} setNotice={setNotice} onOpen={(id) => openFocus({ kind: "conversation", id })} /> : null}
            {view === "settings" ? <SettingsPanel data={data} onChange={refresh} setNotice={setNotice} /> : null}
            {view === "admin" ? <Admin data={data} onChange={refresh} setNotice={setNotice} /> : null}
            {view === "inbox" || view === "dms" || view === "channels" ? <p className="text-muted">Choose a channel or direct message.</p> : null}
          </div>
        </section>
      )}

      {messaging && drawer && focus && detail ? (
        <aside className="drawer">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="font-medium">Details</p>
            <button type="button" className="btn ghost tiny" onClick={() => setDrawer(false)}>Close</button>
          </div>
          <div className="scroll space-y-3 p-3 text-sm">
            <p>Status: {detail.status || "open"}</p>
            <p>Assignee: {detail.assigneeName || "Unassigned"}</p>
            <p>Labels: {detail.labels.join(", ") || "None"}</p>
            <label className="block text-xs text-muted">Add label
              <select className="field mt-1" defaultValue="" onChange={(e) => {
                const label = e.target.value;
                if (!label || !focus) return;
                void updateThread({ data: { kind: focus.kind, id: focus.id, label } }).then((r) => {
                  if (!r.ok) setNotice(r.error);
                  return refresh();
                });
              }}>
                <option value="">Choose</option>
                {data.labels.map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Assign
              <select className="field mt-1" defaultValue="" onChange={(e) => {
                if (!e.target.value || !focus) return;
                void updateThread({ data: { kind: focus.kind, id: focus.id, assigneeId: e.target.value } }).then((r) => {
                  if (!r.ok) setNotice(r.error);
                  return refresh();
                });
              }}>
                <option value="">Choose teammate</option>
                {data.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
              </select>
            </label>
            <ThreadMeta focus={focus} detail={detail} onSave={refresh} />
            <form onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const note = String(fd.get("note") ?? "");
              e.currentTarget.reset();
              if (!focus) return;
              void updateThread({ data: { kind: focus.kind, id: focus.id, note } }).then((r) => {
                if (!r.ok) setNotice(r.error);
                return refresh();
              });
            }}>
              <textarea name="note" className="field" placeholder="Internal note. Not visible as a chat message." rows={3} />
              <button className="btn tiny mt-2" type="submit">Save note</button>
            </form>
            {detail.notes.map((n) => (
              <p key={n.id} className="rounded-lg bg-paper p-2">{n.body}<span className="block text-xs text-muted">{n.authorName}</span></p>
            ))}
            {focus.kind === "conversation" ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn ghost tiny" onClick={() => void setConversationFlags({ data: { id: focus.id, muted: true } }).then(async (r) => {
                  if (!r.ok) setNotice(r.error);
                  else setNotice("Muted.");
                  await refresh();
                })}>Mute</button>
                {isStaff(data.me.role) ? (
                  <button type="button" className="btn ghost tiny" onClick={() => void setConversationFlags({ data: { id: focus.id, archived: true } }).then(async (r) => {
                    if (!r.ok) { setNotice(r.error); return; }
                    setFocus(null);
                    await refresh();
                  })}>Archive for everyone</button>
                ) : null}
              </div>
            ) : null}
          </div>
        </aside>
      ) : null}

      <nav className="tabbar" aria-label="Primary">
        {NAV.filter((item) => PRIMARY.has(item.id)).map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" data-on={view === item.id && pane !== "thread"} onClick={() => go(item.id)}>
              <Icon size={18} />
              {item.label}{item.id === "activity" && activityCount ? ` ${activityCount}` : ""}
            </button>
          );
        })}
        <button type="button" data-on={!messaging} onClick={() => { setSections((s) => ({ ...s, more: true })); setFocus(null); setView("inbox"); }}>
          <Menu size={18} />
          More
        </button>
      </nav>

      {notice ? (
        <div className="notice">
          <div className="flex items-start justify-between gap-3">
            <p>{notice}</p>
            <button type="button" onClick={() => setNotice("")}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChannelForm({ onDone }: { onDone: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState("");
  if (!open) return <button type="button" className="btn ghost w-full" onClick={() => setOpen(true)}>New channel</button>;
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      void createChannel({ data: { name, visibility } }).then(async (r) => {
        if (!r.ok) setError(r.error);
        else { setOpen(false); setName(""); await onDone(r.id); }
      }).catch((err) => setError(errText(err)));
    }}>
      <input className="field" placeholder="channel-name" value={name} onChange={(e) => setName(e.target.value)} />
      <select className="field" value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")}>
        <option value="public">Public</option>
        <option value="private">Private</option>
      </select>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button className="btn w-full" type="submit">Create channel</button>
    </form>
  );
}

function GroupForm({
  members, me, onDone,
}: {
  members: { user_id: string; display_name: string }[];
  me: string;
  onDone: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  if (!open) return <button type="button" className="btn ghost w-full" onClick={() => setOpen(true)}>New group</button>;
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      void createGroup({ data: { name, memberIds: ids } }).then(async (r) => {
        if (!r.ok) { setError(r.error); return; }
        setOpen(false);
        await onDone(r.id);
      }).catch((err) => setError(errText(err)));
    }}>
      <input className="field" placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="max-h-28 space-y-1 overflow-auto text-sm">
        {members.filter((m) => m.user_id !== me).map((m) => (
          <label key={m.user_id} className="flex items-center gap-2">
            <input type="checkbox" checked={ids.includes(m.user_id)} onChange={(e) => {
              setIds((cur) => e.target.checked ? [...cur, m.user_id] : cur.filter((id) => id !== m.user_id));
            }} />
            {m.display_name}
          </label>
        ))}
      </div>
      <button className="btn w-full" type="submit">Create group</button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}

function ThreadMeta({
  focus, detail, onSave,
}: {
  focus: Focus;
  detail: { followUpOn: string; candidateRef: string; status: string };
  onSave: () => Promise<void>;
}) {
  const [followUpOn, setFollow] = useState(detail.followUpOn);
  const [candidateRef, setRef] = useState(detail.candidateRef);
  const [status, setStatus] = useState(detail.status || "open");
  const [error, setError] = useState("");
  useEffect(() => {
    setFollow(detail.followUpOn);
    setRef(detail.candidateRef);
    setStatus(detail.status || "open");
  }, [detail.followUpOn, detail.candidateRef, detail.status, focus.id]);
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      void updateThread({ data: { kind: focus.kind, id: focus.id, followUpOn, candidateRef, status } }).then((r) => {
        if (!r.ok) { setError(r.error); return; }
        setError("");
        return onSave();
      }).catch((err) => setError(errText(err)));
    }}>
      <input className="field" placeholder="Candidate ref (local only)" value={candidateRef} onChange={(e) => setRef(e.target.value)} />
      <input className="field" type="date" value={followUpOn} onChange={(e) => setFollow(e.target.value)} />
      <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="open">Open</option>
        <option value="waiting">Waiting</option>
        <option value="resolved">Resolved</option>
      </select>
      <button className="btn tiny" type="submit">Save follow-up</button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}

function Activity({ items, onRead }: { items: { id: string; body: string; read: boolean; createdAt: string }[]; onRead: () => Promise<void> }) {
  return (
    <div className="space-y-3">
      <button type="button" className="btn tiny" onClick={() => void onRead()}>Mark all read</button>
      {items.length === 0 ? <p className="text-muted">No notifications yet. Assignments, escalations, and due reminders show up here.</p> : null}
      {items.map((n) => (
        <article key={n.id} className="card">
          <p>{n.body}</p>
          <p className="text-xs text-muted">{timeLabel(n.createdAt)} · {n.read ? "Read" : "Unread"}</p>
        </article>
      ))}
    </div>
  );
}

function Automations({
  data, onChange, setNotice,
}: {
  data: Awaited<ReturnType<typeof bootstrap>>;
  onChange: () => Promise<void>;
  setNotice: (s: string) => void;
}) {
  const blank = {
    trigger: { type: "keyword", value: "", channelId: "" },
    match: "all",
    conditions: [] as { type: string; value: string }[],
    actions: [{ type: "reply", value: "" }],
  };
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [config, setConfig] = useState(blank);
  const [editing, setEditing] = useState<string | undefined>(undefined);

  function load(w: (typeof data.workflows)[number]) {
    setEditing(w.id);
    setName(w.name);
    setDescription(w.description);
    try { setConfig(JSON.parse(w.configJson)); } catch { setConfig(blank); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-3">
        {data.workflows.map((w) => (
          <article key={w.id} className="card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-medium">{w.name}</h2>
                <p className="text-sm text-muted">{w.description}</p>
                <p className="text-xs text-muted">{w.enabled ? "Enabled" : "Disabled"}{w.lastRunAt ? ` · last run ${timeLabel(w.lastRunAt)}` : ""}</p>
              </div>
              <button type="button" className="btn ghost tiny" onClick={() => load(w)}>Edit</button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn ghost tiny" onClick={() => void setWorkflowEnabled({ data: { id: w.id, enabled: !w.enabled } }).then((r) => { if (!r.ok) setNotice(r.error); return onChange(); })}>{w.enabled ? "Disable" : "Enable"}</button>
              <button type="button" className="btn ghost tiny" onClick={() => void testWorkflow({ data: { id: w.id } }).then((r) => setNotice(r.ok ? r.detail : r.error)).then(onChange)}>Test</button>
              <button type="button" className="btn ghost tiny" onClick={() => void duplicateWorkflow({ data: { id: w.id } }).then((r) => { if (!r.ok) setNotice(r.error); return onChange(); })}>Duplicate</button>
              <button type="button" className="btn ghost tiny" onClick={() => void deleteWorkflow({ data: { id: w.id } }).then((r) => { if (!r.ok) setNotice(r.error); return onChange(); })}>Delete</button>
            </div>
          </article>
        ))}
        <h3 className="pt-2 font-medium">Recent runs</h3>
        {data.runs.map((r) => (
          <p key={r.id} className="text-sm"><span className="font-medium">{r.status}</span> — {r.detail}</p>
        ))}
        {data.runs.length === 0 ? <p className="text-sm text-muted">No workflow has run yet. Test mode does not send anything.</p> : null}
      </div>
      <form className="card space-y-3" onSubmit={(e) => {
        e.preventDefault();
        void saveWorkflow({
          data: { id: editing, name, description, enabled: true, configJson: JSON.stringify(config) },
        }).then(async (r) => {
          if (!r.ok) setNotice(r.error);
          else { setNotice("Workflow saved."); setEditing(r.id); await onChange(); }
        });
      }}>
        <h2 className="font-serif text-2xl">{editing ? "Edit workflow" : "New workflow"}</h2>
        <input className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea className="field" placeholder="What this workflow is for" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <label className="block text-sm">Trigger
          <select className="field mt-1" value={config.trigger.type} onChange={(e) => setConfig({ ...config, trigger: { ...config.trigger, type: e.target.value } })}>
            <option value="keyword">Message contains keyword</option>
            <option value="mention">Message mentions</option>
            <option value="channel_message">Message posted in a channel</option>
            <option value="schedule">Every N minutes</option>
            <option value="unanswered">No human reply for N minutes</option>
          </select>
        </label>
        <input className="field" placeholder={config.trigger.type === "schedule" || config.trigger.type === "unanswered" ? "Minutes, at least 5" : "Keyword, mention, or leave blank for any channel message"} value={config.trigger.value} onChange={(e) => setConfig({ ...config, trigger: { ...config.trigger, value: e.target.value } })} />
        <label className="block text-sm">Limit to channel
          <select className="field mt-1" value={config.trigger.channelId ?? ""} onChange={(e) => setConfig({ ...config, trigger: { ...config.trigger, channelId: e.target.value } })}>
            <option value="">Any channel</option>
            {data.channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
        <p className="text-sm font-medium">Actions, in order</p>
        {config.actions.map((action, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[9rem_1fr_auto]">
            <select className="field" value={action.type} onChange={(e) => {
              const actions = config.actions.slice();
              actions[i] = { ...action, type: e.target.value };
              setConfig({ ...config, actions });
            }}>
              <option value="reply">Reply in thread</option>
              <option value="label">Add label</option>
              <option value="task">Create task</option>
              <option value="note">Internal note</option>
              <option value="notify">Notify teammates</option>
              <option value="webhook">Call webhook</option>
              <option value="whatsapp">WhatsApp text</option>
              <option value="telegram">Telegram text</option>
              <option value="email">Email</option>
              <option value="calendar">Calendar event</option>
              <option value="external_task">External task</option>
            </select>
            <input className="field" value={action.value} placeholder="Value" onChange={(e) => {
              const actions = config.actions.slice();
              actions[i] = { ...action, value: e.target.value };
              setConfig({ ...config, actions });
            }} />
            <button type="button" className="btn ghost tiny" onClick={() => setConfig({ ...config, actions: config.actions.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn ghost tiny" onClick={() => setConfig({ ...config, actions: [...config.actions, { type: "task", value: "" }] })}>Add action</button>
        <p className="text-xs text-muted">Test never calls a provider. WhatsApp needs digits then the message. Telegram needs a numeric chat id then the message. Email is to | subject | message. Calendar is title | start time. A failed provider call stays failed.</p>
        <div className="flex gap-2">
          <button className="btn" type="submit">Save workflow</button>
          <button className="btn ghost" type="button" onClick={() => { setEditing(undefined); setName(""); setDescription(""); setConfig(blank); }}>Clear</button>
        </div>
      </form>
    </div>
  );
}

function Bots({
  data, onChange, setNotice,
}: {
  data: Awaited<ReturnType<typeof bootstrap>>;
  onChange: () => Promise<void>;
  setNotice: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const command = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted">
        Built-in commands stay /help, /ask, /assign, /remind, /summarize, /create-task, and /escalate. A bot you create replies when someone types its name with spaces removed.
      </p>
      {data.bots.map((b) => {
        const slash = b.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        return (
          <article key={b.id} className="card">
            <h2 className="font-medium">{b.name}</h2>
            <p className="text-sm text-muted">{b.description}</p>
            <p className="text-xs text-muted">{b.enabled ? "Enabled" : "Disabled"} · {b.system ? "Built in" : `Custom · type /${slash}`}</p>
            <button type="button" className="btn ghost tiny mt-2" onClick={() => void saveBot({ data: { id: b.id, name: b.name, description: b.description, enabled: !b.enabled } }).then(async (r) => { if (!r.ok) setError(r.error); else setError(""); await onChange(); }).catch((e) => setError(errText(e)))}>
              {b.enabled ? "Disable" : "Enable"}
            </button>
          </article>
        );
      })}
      <form className="card space-y-2" onSubmit={(e) => {
        e.preventDefault();
        setError("");
        void saveBot({ data: { name, description, enabled: true } }).then(async (r) => {
          if (!r.ok) { setError(r.error); return; }
          setNotice(`Bot created. In a channel or direct message, type /${command}.`);
          setName("");
          setDescription("");
          await onChange();
        }).catch((e) => setError(errText(e)));
      }}>
        <h2 className="font-medium">New bot</h2>
        <input className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea className="field" placeholder="What this bot should reply" value={description} onChange={(e) => setDescription(e.target.value)} />
        {command.length >= 2 ? <p className="text-xs text-muted">Command: /{command}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button className="btn" type="submit">Create bot</button>
      </form>
      <h3 className="font-medium">Command log</h3>
      {data.logs.map((l) => <p key={l.id} className="text-sm"><span className="font-medium">{l.command}</span> — {l.result}</p>)}
      <div className="card space-y-2">
        <h3 className="font-medium">AI drafts waiting</h3>
        <p className="text-sm text-muted">{data.ai.configured ? `Model ${data.ai.model} is configured.` : "AI is not configured. Nothing here is a sent message."} {data.ai.requireApproval ? "Approval is required before a draft is posted." : "Approval is off, so /ask posts directly."}</p>
        {data.drafts.length === 0 ? <p className="text-sm text-muted">No pending drafts.</p> : data.drafts.map((d) => (
          <article key={d.id} className="rounded-lg border border-line p-3">
            <p className="text-sm">{d.body}</p>
            <p className="mt-1 text-xs text-muted">Draft only. Not sent.</p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn tiny" onClick={() => void approveDraft({ data: { id: d.id } }).then(async (r) => { setNotice(r.ok ? "Draft posted in the thread." : r.error); await onChange(); })}>Approve and send</button>
              <button type="button" className="btn ghost tiny" onClick={() => void rejectDraft({ data: { id: d.id } }).then(async (r) => { if (!r.ok) setNotice(r.error); await onChange(); })}>Reject</button>
            </div>
          </article>
        ))}
      </div>
      <div className="card">
        <h3 className="font-medium">Open tasks</h3>
        {data.tasks.filter((t) => t.status !== "done").map((t) => (
          <label key={t.id} className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" onChange={() => void saveTask({ data: { id: t.id, done: true } }).then(onChange)} />
            {t.title}
          </label>
        ))}
        {data.tasks.filter((t) => t.status !== "done").length === 0 ? <p className="text-sm text-muted">No open tasks.</p> : null}
      </div>
    </div>
  );
}

function integrationLabel(provider: string, status: string, note: string) {
  if (provider !== "storage") return status;
  if (status === "operational" || note.startsWith("Operational")) return "Operational";
  if (note.startsWith("Configuration error")) return "Configuration error";
  if (note.startsWith("Connection failed") || status === "error") return "Connection failed";
  return "Not configured";
}

function Integrations({
  data, onChange, setNotice,
}: {
  data: Awaited<ReturnType<typeof bootstrap>>;
  onChange: () => Promise<void>;
  setNotice: (s: string) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.integrations.map((i) => (
        <article key={i.provider} className="card">
          <p className="text-xs uppercase tracking-wide text-muted">{integrationLabel(i.provider, i.status, i.note)}</p>
          <h2 className="font-medium capitalize">{i.provider}</h2>
          <p className="text-sm text-muted">{i.note}</p>
          <button type="button" className="btn ghost tiny mt-3" onClick={() => void testIntegration({ data: { provider: i.provider } }).then(async (r) => {
            setNotice(r.ok ? r.note : r.error);
            await onChange();
          })}>Test connection</button>
          {i.provider === "telegram" ? (
            <button type="button" className="btn ghost tiny mt-3 ml-2" onClick={() => void registerTelegramHook().then(async (r) => {
              setNotice(r.ok ? r.note : r.error);
              await onChange();
            })}>Register webhook</button>
          ) : null}
        </article>
      ))}
      <p className="text-sm text-muted md:col-span-2">
        A provider stays not configured until its credentials exist, and it is marked operational only after that provider accepts a real request. Storage is operational only after R2 accepts a write, a read, and a delete. Testing WhatsApp, Telegram, or email does not send a customer message. CRM and the candidate portal are reachability checks only, because those products do not publish an API this app can call.
      </p>
    </div>
  );
}

function Files({ onError }: { onError: (s: string) => void }) {
  const q = useQuery({ queryKey: ["files"], queryFn: () => listFiles() });
  if (q.isPending) return <p className="text-muted">Loading files you can access…</p>;
  if (!q.data?.length) return <p className="text-muted">No shared files yet. Files already saved in messages stay there. Without Cloudflare R2, new files over 120 KB are refused. With R2, new files up to 8 MB go to a private bucket and open with a five-minute link.</p>;
  return (
    <div className="space-y-2">
      {q.data.map((f) => (
        <button key={f.id} type="button" className="card block w-full text-left" onClick={() => void fileData({ data: { id: f.id } }).then((r) => {
          if (!r.ok) { onError(r.error); return; }
          const a = document.createElement("a");
          a.href = r.data;
          a.download = r.name;
          a.click();
        })}>
          <p className="font-medium">{f.name}</p>
          <p className="text-xs text-muted">{timeLabel(f.createdAt)}</p>
        </button>
      ))}
    </div>
  );
}

function Stats() {
  const q = useQuery({ queryKey: ["analytics"], queryFn: () => analytics() });
  if (q.isPending) return <p className="text-muted">Counting live workspace data…</p>;
  if (!q.data || !q.data.ok) return <p className="text-danger">{q.data && !q.data.ok ? q.data.error : "Analytics unavailable."}</p>;
  const a = q.data;
  const cards = [
    ["Messages", a.totalMessages],
    ["People", a.activeUsers],
    ["Conversations", a.conversations],
    ["Open tasks", a.openTasks],
    ["Pending reminders", a.pendingReminders],
    ["Bot commands", a.botRuns],
  ] as const;
  const max = Math.max(1, ...a.byChannel.map((c) => c.n));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{a.note}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map(([label, n]) => (
          <article key={label} className="card">
            <p className="text-xs text-muted">{label}</p>
            <p className="font-serif text-3xl">{n}</p>
          </article>
        ))}
      </div>
      <article className="card">
        <h2 className="mb-3 font-medium">Messages by channel</h2>
        {a.byChannel.map((c) => (
          <div key={c.name} className="mb-2">
            <div className="mb-1 flex justify-between text-xs"><span>#{c.name}</span><span>{c.n}</span></div>
            <div className="h-2 rounded-full bg-paper">
              <div className="h-2 rounded-full bg-accent" style={{ width: `${Math.round((c.n / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </article>
      <article className="card">
        <h2 className="mb-2 font-medium">Workflow results</h2>
        {a.workflowRuns.length === 0 ? <p className="text-sm text-muted">No runs recorded.</p> : a.workflowRuns.map((r) => (
          <p key={r.status} className="text-sm">{r.status}: {r.n}</p>
        ))}
        <h3 className="mt-3 font-medium">Last 7 days</h3>
        {a.trend.length === 0 ? <p className="text-sm text-muted">No messages in the last 7 days beyond what you send next.</p> : a.trend.map((t) => (
          <p key={t.day} className="text-sm">{t.day}: {t.n}</p>
        ))}
      </article>
    </div>
  );
}

function Members({
  data, onChange, setNotice, onOpen,
}: {
  data: Awaited<ReturnType<typeof bootstrap>>;
  onChange: () => Promise<void>;
  setNotice: (s: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      {data.members.map((m) => (
        <article key={m.user_id} className="card flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-medium">{m.display_name}</p>
            <p className="text-xs text-muted">{m.email} · {m.presence} · {m.role}</p>
          </div>
          <button type="button" className="btn ghost tiny" onClick={() => void openDm({ data: { userId: m.user_id } }).then((r) => {
            if (!r.ok) setNotice(r.error);
            else onOpen(r.id);
            return onChange();
          })}>Message</button>
        </article>
      ))}
      <p className="text-sm text-muted">Anyone who signs in joins Officium Connect. The first account becomes owner. Invite codes in Admin can change a member’s role.</p>
    </div>
  );
}

function SettingsPanel({
  data, onChange, setNotice,
}: {
  data: Awaited<ReturnType<typeof bootstrap>>;
  onChange: () => Promise<void>;
  setNotice: (s: string) => void;
}) {
  const [displayName, setName] = useState(data.me.name);
  const [presence, setPresence] = useState(data.me.presence);
  const [notifyPref, setNotify] = useState(data.me.notifyPref);
  const [code, setCode] = useState("");
  return (
    <div className="max-w-xl space-y-4">
      <form className="card space-y-2" onSubmit={(e) => {
        e.preventDefault();
        void updateProfile({ data: { displayName, presence: presence as "active" | "away" | "offline", notifyPref: notifyPref as "all" | "mentions" | "off" } }).then(async () => {
          setNotice("Profile saved.");
          await onChange();
        }).catch((err) => setNotice(errText(err)));
      }}>
        <h2 className="font-medium">Your profile</h2>
        <input className="field" value={displayName} onChange={(e) => setName(e.target.value)} />
        <select className="field" value={presence} onChange={(e) => setPresence(e.target.value)}>
          <option value="active">Active</option>
          <option value="away">Away</option>
          <option value="offline">Offline</option>
        </select>
        <select className="field" value={notifyPref} onChange={(e) => setNotify(e.target.value)}>
          <option value="all">All in-app alerts</option>
          <option value="mentions">Fewer alerts</option>
          <option value="off">No workflow alerts</option>
        </select>
        <button className="btn" type="submit">Save</button>
      </form>
      <form className="card space-y-2" onSubmit={(e) => {
        e.preventDefault();
        void redeemInvite({ data: { code } }).then(async (r) => {
          setNotice(r.ok ? `Role is now ${r.role}.` : r.error);
          await onChange();
        });
      }}>
        <h2 className="font-medium">Invite code</h2>
        <input className="field" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from an administrator" />
        <button className="btn ghost" type="submit">Apply code</button>
      </form>
      <article className="card space-y-2 text-sm">
        <h2 className="font-medium">Assistant</h2>
        <p className="text-muted">{data.ai.configured ? `${data.ai.model} is available on the server.` : "No AI key is configured. /ask will say so and will not invent a reply."}</p>
        <p className="text-muted">Files use {data.ai.storage === "object" ? "private Cloudflare R2, up to 8 MB" : "the database, capped at 120 KB"}.</p>
        {data.me.role === "owner" || data.me.role === "administrator" || data.me.role === "manager" ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn ghost tiny" onClick={() => void relocateFiles({ data: { dryRun: true } }).then(async (r) => {
              setNotice(r.ok ? r.note : r.error);
            })}>Preview file move</button>
            <button type="button" className="btn ghost tiny" onClick={() => void relocateFiles().then(async (r) => {
              setNotice(r.ok ? r.note : r.error);
              await onChange();
            })}>Copy database files to R2</button>
            <button type="button" className="btn ghost tiny" onClick={() => void relocateFiles({ data: { cleanup: true } }).then(async (r) => {
              setNotice(r.ok ? r.note : r.error);
              await onChange();
            })}>Remove verified database copies</button>
          </div>
        ) : null}
        {data.me.role === "owner" || data.me.role === "administrator" || data.me.role === "manager" ? (
          <form key={`${data.ai.enabled}-${data.ai.requireApproval}`} className="space-y-2" onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void setAiSettings({ data: { enabled: form.get("enabled") === "on", requireApproval: form.get("approval") === "on" } }).then(async (r) => {
              setNotice(r.ok ? "Assistant settings saved." : r.error);
              await onChange();
            });
          }}>
            <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={data.ai.enabled} /> Allow /ask</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="approval" defaultChecked={data.ai.requireApproval} /> Require approval before posting</label>
            <button className="btn" type="submit">Save assistant</button>
          </form>
        ) : <p className="text-muted">A manager controls whether /ask is on.</p>}
      </article>
      <article className="card text-sm text-muted">
        <p className="font-medium text-fg">What is real today</p>
        <p className="mt-1">Accounts, channels, direct and group messages, reactions, notes, labels, tasks, reminders, workflows, and bot commands are stored in the database.</p>
        <p className="mt-2">Reminders and scheduled workflows also run from the host scheduler when it is configured. Until that secret is set, they still run on the next visit so nothing is lost, but that is not a substitute for the scheduler.</p>
        <p className="mt-2">New messages refresh about every few seconds. This host does not keep a durable websocket open, so the app does not pretend to.</p>
        <p className="mt-2">Planned address: message.officiumconnect.in. The published app, database, and domain stay yours after you deploy.</p>
      </article>
    </div>
  );
}

function Admin({
  data, onChange, setNotice,
}: {
  data: Awaited<ReturnType<typeof bootstrap>>;
  onChange: () => Promise<void>;
  setNotice: (s: string) => void;
}) {
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => listAudit(), enabled: isAdmin(data.me.role) });
  const [role, setRoleChoice] = useState<"member" | "manager" | "administrator" | "guest">("member");
  if (!isAdmin(data.me.role)) return <p className="text-muted">Administration is limited to the owner and administrators.</p>;
  return (
    <div className="space-y-4">
      <form className="card space-y-2" onSubmit={(e) => {
        e.preventDefault();
        void createInvite({ data: { role } }).then((r) => setNotice(r.ok ? `Invite code: ${r.code}` : r.error));
      }}>
        <h2 className="font-medium">Invite</h2>
        <select className="field" value={role} onChange={(e) => setRoleChoice(e.target.value as typeof role)}>
          <option value="member">Member</option>
          <option value="manager">Manager</option>
          <option value="administrator">Administrator</option>
          <option value="guest">Guest</option>
        </select>
        <button className="btn" type="submit">Create invite code</button>
      </form>
      <div className="space-y-2">
        {data.members.map((m) => (
          <div key={m.user_id} className="card flex flex-wrap items-center justify-between gap-2">
            <p>{m.display_name}</p>
            <select className="field max-w-48" value={m.role} disabled={m.role === "owner" && data.me.role !== "owner"} onChange={(e) => void setRole({ data: { userId: m.user_id, role: e.target.value as "owner" | "administrator" | "manager" | "member" | "guest" } }).then(async (r) => {
              if (!r.ok) setNotice(r.error);
              await onChange();
            })}>
              <option value="owner" disabled={data.me.role !== "owner"}>Owner</option>
              <option value="administrator">Administrator</option>
              <option value="manager">Manager</option>
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </div>
        ))}
      </div>
      <article className="card">
        <h2 className="font-medium">Audit</h2>
        {audit.data && audit.data.ok ? audit.data.rows.map((r, i) => (
          <p key={`${r.createdAt}-${i}`} className="text-sm">{r.actor} · {r.action} · {r.detail}</p>
        )) : <p className="text-sm text-muted">{audit.data && !audit.data.ok ? audit.data.error : "Loading audit…"}</p>}
      </article>
    </div>
  );
}
