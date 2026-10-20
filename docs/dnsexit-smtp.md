# DNSExit SMTP provider for ATLAS

The provider is opt-in. Production must remain on `EMAIL_PROVIDER=MOCK` until a controlled live test is explicitly scheduled and verified.

## Runtime configuration

Set these on the Cloudflare Worker Production environment:

- `EMAIL_PROVIDER`: `DNSEXIT_SMTP` (do not change from MOCK until validation is complete)
- `EMAIL_FROM`: a sender address authorized by DNSExit and using the domain whose SPF/DKIM were verified
- `DNS_EXIT_SMTP_HOST`: optional; defaults to `relay.dnsexit.com`
- `DNS_EXIT_SMTP_PORT`: optional; defaults to `587`
- `DNS_EXIT_SMTP_USERNAME`: Secret; the SMTP relay username shown in DNSExit
- `DNS_EXIT_SMTP_PASSWORD`: Secret; the SMTP relay password

Port 587 uses STARTTLS. The transport fails closed if STARTTLS is not advertised, sender/recipient validation fails, or the server does not accept the message after DATA. It does not automatically retry against the backup host because a connection failure after DATA may leave delivery outcome ambiguous and an automatic retry could duplicate a message.

## Verification plan

1. Run `npm test` and review the DNSExit SMTP tests. They use a fake socket; they do not contact DNSExit or send email.
2. Keep production on `MOCK` while adding the two SMTP credentials as Cloudflare Secrets. Never store credentials in Git, ordinary variables, chat, or logs.
3. Confirm the intended sender address in DNSExit and configure `EMAIL_FROM` as a non-secret variable.
4. Only after code review and a passing CI run, perform one controlled live test to an inbox you control. Then inspect DNSExit sending activity and verify the received message.
5. Only after that evidence is reviewed should the production provider be changed from `MOCK` to `DNSEXIT_SMTP`.

DNSExit relay limits/pricing are account-dependent; do not upgrade or enable pay-as-you-go.
