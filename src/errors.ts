// Turns an API or network error into one plain sentence for the user.
export function describeError(error: unknown) {
  const value = error as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const message = value?.error?.error?.message ?? value?.message ?? String(error);
  if (value?.status === 401)
    return `Claude rejected the credentials (401). Run \`clue login\` or check ANTHROPIC_API_KEY. ${message}`;
  if (value?.status === 429) return `Rate limited by the API (429). ${message}`;
  if (value?.status && value.status >= 500) return `The API had an error (${value.status}). ${message}`;
  return message;
}
