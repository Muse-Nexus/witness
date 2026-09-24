// Forwarding-confirmation links arrive by email, and email can be spoofed. Only Gmail sends a
// confirmation link, so only Gmail's own forwarding-confirmation pages are linked to (the same
// exact hosts and path core accepts, apps/core/src/inbound-email.ts). Hosts that serve pages
// anyone can write (forms, shared notes, OAuth consent) never get a "Confirm it" button.
const CONFIRMATION_HOSTS = ['mail-settings.google.com', 'isolated.mail.google.com', 'mail.google.com'];
const CONFIRMATION_PATH = '/mail/vf-';

export function safeConfirmationUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  return CONFIRMATION_HOSTS.includes(host) && url.pathname.startsWith(CONFIRMATION_PATH) ? url.href : null;
}

export function providerName(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'gmail':
      return 'Gmail';
    case 'outlook':
      return 'Outlook';
    case 'icloud':
      return 'iCloud';
    default:
      return 'Your email provider';
  }
}
