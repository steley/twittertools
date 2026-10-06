/** X hides a reply's leading @mention of the account it answers (the reply
 * prefill); the syndication text still carries it. Drop that first mention
 * unless it addresses the post's own author. `isReply` gates posts that are
 * not replies (e.g. a standalone opening post keeps its mentions). */
export function splitReplyMention(
  text: string,
  ownHandle: string | undefined,
  isReply: boolean,
): { text: string; mention: string | null } {
  const m = text.match(/^@([A-Za-z0-9_]{1,15})\s+/);
  if (!m || !isReply || m[1].toLowerCase() === (ownHandle ?? '').toLowerCase()) {
    return { text, mention: null };
  }
  return { text: text.slice(m[0].length), mention: m[1] };
}

export function stripReplyMention(text: string, ownHandle: string | undefined, isReply: boolean): string {
  return splitReplyMention(text, ownHandle, isReply).text;
}
