export function deriveAgentEmail(baseEmail, slug) {
  if (!baseEmail) return null;
  const at = baseEmail.lastIndexOf('@');
  if (at <= 0) return baseEmail;
  const local = baseEmail.slice(0, at);
  const domain = baseEmail.slice(at + 1);
  if (/(^|\.)noreply\.github\.com$/i.test(domain) || local.includes('+')) return baseEmail;
  return `${local}+${slug}@${domain}`;
}

export function resolveAgentIdentity({ baseEmail, slug, displayName, override = {} }) {
  const fallbackName = String(slug).split(/[-_]+/).filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return {
    name: override.botName ?? displayName ?? fallbackName,
    email: baseEmail ? override.botEmail ?? deriveAgentEmail(baseEmail, slug) : null,
  };
}
