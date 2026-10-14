---
name: GitHub authorization verification
description: Verify GitHub CLI access rather than trusting the connection card before publishing.
---

Treat GitHub authorization as unverified until an authenticated provider operation succeeds.

**Why:** In this workspace, the platform reported a healthy connected GitHub provider while `gh` had no login and Git authentication failed. Reconnection forms also rejected the supposedly connected provider.

**How to apply:** Verify account identity and repository permissions before creating or publishing repositories. If CLI access and connection status disagree, do not request credentials in chat or silently use a different account. Use the integration recovery flow, and report the blocker if recovery cannot open.

When repeated integration reconnection fails to provide CLI credentials, a GitHub token supplied through the secure Replit Secrets form is a working fallback. Verify its account identity before use and scan the token as well as the CFBD key before publishing.

**Why:** The integration remained unusable after reconnection, but a securely supplied token restored authenticated GitHub access.

**How to apply:** Keep credentials out of Git URLs, command arguments, tracked configuration, and command-error logs. Use environment-based authentication and fail explicitly when credentials expire.
