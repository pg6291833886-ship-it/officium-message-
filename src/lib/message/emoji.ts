export type Emoji = { char: string; name: string };

/** Small original set for the composer. Names are search keywords, not a third-party catalog. */
export const EMOJIS: Emoji[] = [
  { char: "😀", name: "smile happy grin" },
  { char: "😁", name: "grin happy" },
  { char: "😂", name: "joy laugh" },
  { char: "🙂", name: "slight smile" },
  { char: "😉", name: "wink" },
  { char: "😊", name: "blush happy" },
  { char: "😍", name: "heart eyes love" },
  { char: "🤔", name: "think question" },
  { char: "😐", name: "neutral" },
  { char: "😴", name: "sleep tired" },
  { char: "😎", name: "cool" },
  { char: "😢", name: "cry sad" },
  { char: "😭", name: "sob sad" },
  { char: "😡", name: "angry" },
  { char: "😱", name: "scream shock" },
  { char: "🙏", name: "please thanks pray" },
  { char: "👍", name: "yes thumb up ok" },
  { char: "👎", name: "no thumb down" },
  { char: "👏", name: "clap" },
  { char: "🙌", name: "hooray raise" },
  { char: "👋", name: "wave hello" },
  { char: "🤝", name: "handshake deal" },
  { char: "💪", name: "strong" },
  { char: "👀", name: "eyes look" },
  { char: "✅", name: "check done yes" },
  { char: "❌", name: "cross no" },
  { char: "⚠️", name: "warning caution" },
  { char: "🔥", name: "fire urgent" },
  { char: "⭐", name: "star" },
  { char: "💡", name: "idea" },
  { char: "📌", name: "pin" },
  { char: "📝", name: "note write" },
  { char: "📅", name: "calendar date" },
  { char: "⏰", name: "clock time remind" },
  { char: "📞", name: "phone call" },
  { char: "✉️", name: "email mail" },
  { char: "💬", name: "message chat" },
  { char: "🔒", name: "lock private" },
  { char: "🔓", name: "unlock" },
  { char: "🎉", name: "party celebrate" },
  { char: "🎯", name: "target goal" },
  { char: "🚀", name: "rocket launch" },
  { char: "💼", name: "work briefcase job" },
  { char: "📄", name: "file document" },
  { char: "📎", name: "attachment clip" },
  { char: "❤️", name: "heart love" },
  { char: "💙", name: "blue heart" },
  { char: "💚", name: "green heart" },
  { char: "💯", name: "hundred perfect" },
  { char: "🙏", name: "folded hands" },
];

export function searchEmojis(query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: Emoji[] = [];
  for (const emoji of EMOJIS) {
    if (seen.has(emoji.char)) continue;
    if (q && !emoji.name.includes(q) && !emoji.char.includes(q)) continue;
    seen.add(emoji.char);
    out.push(emoji);
  }
  return out;
}
