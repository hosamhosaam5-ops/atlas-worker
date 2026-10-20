// DNSExit SMTP configuration contract. Live sending is implemented by the email adapter.
export const DNS_EXIT_SMTP_DEFAULTS = Object.freeze({
  host: 'relay.dnsexit.com',
  port: 587,
  secureTransport: 'starttls',
});
